package info.internext.pos.counter;

import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.print.PrintAttributes;
import android.print.PrintJob;
import android.print.PrintManager;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;

/** Online-only counter shell. No JavaScript interface, local sales database, or offline issuer. */
public final class CounterActivity extends ComponentActivity {
    private WebView web;
    private FrameLayout page;
    private LinearLayout unavailable;
    private TextView unavailableTitle;
    private TextView unavailableMessage;
    private Button resume;
    private Button print;
    private ProgressBar progress;
    private ConnectivityManager connectivity;
    private boolean pageReady;
    private boolean pageFailed;
    private boolean callbackRegistered;
    private boolean networkWasUnavailable;
    private PrintJob printJob;

    private final ConnectivityManager.NetworkCallback networkCallback = new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(Network network) { updateConnectionOnUi(); }
        @Override public void onLost(Network network) { updateConnectionOnUi(); }
        @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
            updateConnectionOnUi();
        }
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        WebView.setWebContentsDebuggingEnabled(false);
        connectivity = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(244, 247, 250));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        setContentView(root);

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(12), dp(3), dp(8), dp(3));
        TextView brand = new TextView(this);
        brand.setText("Internext Counter\nInternet required");
        brand.setTextSize(14);
        brand.setTextColor(Color.rgb(19, 54, 65));
        toolbar.addView(brand, new LinearLayout.LayoutParams(0, dp(54), 1));
        Button reload = button("Reload");
        reload.setOnClickListener(v -> confirmReload());
        toolbar.addView(reload);
        print = button("Print receipt");
        print.setEnabled(false);
        print.setOnClickListener(v -> printReceipt());
        toolbar.addView(print);
        root.addView(toolbar);

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        root.addView(progress, new LinearLayout.LayoutParams(-1, dp(3)));
        page = new FrameLayout(this);
        root.addView(page, new LinearLayout.LayoutParams(-1, 0, 1));
        createWebView();
        createUnavailablePanel();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { navigateBack(); }
        });
        if (connectivity != null) {
            connectivity.registerDefaultNetworkCallback(networkCallback);
            callbackRegistered = true;
        }
        web.loadUrl(CounterOrigin.HOME);
        updateConnection();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView() {
        web = new WebView(this);
        web.setContentDescription("Internext online point of sale");
        WebSettings settings = web.getSettings();
        // The first-party React counter needs JavaScript and IndexedDB for request recovery.
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setGeolocationEnabled(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        if (Build.VERSION.SDK_INT >= 26) settings.setSafeBrowsingEnabled(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setDownloadListener((url, userAgent, disposition, mime, length) ->
                Toast.makeText(this, "Downloads are unavailable here. Use Print for a saved receipt.", Toast.LENGTH_LONG).show());
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int value) {
                progress.setProgress(value);
                progress.setVisibility(value < 100 ? View.VISIBLE : View.INVISIBLE);
            }
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return blockUntrustedNavigation(request.getUrl().toString());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return blockUntrustedNavigation(url);
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                pageReady = false;
                pageFailed = false;
                print.setEnabled(false);
                if (!CounterOrigin.allowed(url)) {
                    view.stopLoading();
                    showUnavailable("Page blocked", "Only the secure Internext counter can open in this app.");
                    pageFailed = true;
                }
            }
            @Override public void onPageFinished(WebView view, String url) {
                pageReady = !pageFailed && CounterOrigin.allowed(url);
                CookieManager.getInstance().flush();
                updateConnection();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) failPage("Counter could not load",
                        "Check the internet connection, then use Reload. Review Receipts before retrying an interrupted sale.");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 400) {
                    failPage("Counter temporarily unavailable", "The server could not open the counter. Try Reload shortly. An interrupted sale must be checked in Receipts before retrying.");
                }
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                failPage("Secure connection unavailable", "Check the device date and internet connection. This app will not bypass certificate errors.");
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                page.removeView(view);
                view.destroy();
                web = null;
                failPage("Counter needs to reopen", "Use Reload, then review Receipts before retrying an interrupted sale.");
                return true;
            }
        });
        page.addView(web, 0, new FrameLayout.LayoutParams(-1, -1));
    }

    private boolean blockUntrustedNavigation(String url) {
        boolean blocked = !CounterOrigin.allowed(url);
        if (blocked) Toast.makeText(this, "Only the secure Internext counter can open here.", Toast.LENGTH_SHORT).show();
        return blocked;
    }

    private void createUnavailablePanel() {
        unavailable = new LinearLayout(this);
        unavailable.setOrientation(LinearLayout.VERTICAL);
        unavailable.setGravity(Gravity.CENTER);
        unavailable.setPadding(dp(28), dp(20), dp(28), dp(20));
        unavailable.setBackgroundColor(Color.rgb(244, 247, 250));
        unavailableTitle = new TextView(this);
        unavailableTitle.setTextSize(23);
        unavailableTitle.setTextColor(Color.rgb(19, 54, 65));
        unavailableTitle.setGravity(Gravity.CENTER);
        unavailable.addView(unavailableTitle);
        unavailableMessage = new TextView(this);
        unavailableMessage.setTextSize(16);
        unavailableMessage.setGravity(Gravity.CENTER);
        unavailableMessage.setPadding(0, dp(18), 0, dp(18));
        unavailable.addView(unavailableMessage);
        resume = button("Continue to counter");
        resume.setOnClickListener(v -> updateConnection());
        unavailable.addView(resume);
        Button retry = button("Reload counter");
        retry.setOnClickListener(v -> confirmReload());
        unavailable.addView(retry);
        page.addView(unavailable, new FrameLayout.LayoutParams(-1, -1));
        unavailable.setVisibility(View.GONE);
    }

    private boolean hasInternet() {
        if (connectivity == null) return false;
        Network active = connectivity.getActiveNetwork();
        NetworkCapabilities capabilities = active == null ? null : connectivity.getNetworkCapabilities(active);
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
    }

    private void updateConnectionOnUi() {
        runOnUiThread(() -> { if (!isFinishing() && !isDestroyed()) updateConnection(); });
    }

    private void updateConnection() {
        if (unavailable == null) return;
        boolean connected = hasInternet();
        print.setEnabled(connected && pageReady && web != null);
        resume.setVisibility(connected && pageReady ? View.VISIBLE : View.GONE);
        if (!connected) {
            networkWasUnavailable = true;
            showUnavailable("Internet connection required", "Sales cannot be saved offline in this version. Reconnect, then review Receipts before retrying an interrupted sale. Your current screen is kept while the app stays open.");
        } else if (pageReady) {
            networkWasUnavailable = false;
            unavailable.setVisibility(View.GONE);
            if (web != null) web.setVisibility(View.VISIBLE);
        } else if (networkWasUnavailable) {
            networkWasUnavailable = false;
            showUnavailable("Connection restored", "Use Reload counter to open the counter. Review Receipts before retrying an interrupted sale.");
        }
    }

    private void failPage(String title, String message) {
        pageReady = false;
        pageFailed = true;
        print.setEnabled(false);
        showUnavailable(title, message);
    }

    private void showUnavailable(String title, String message) {
        if (unavailable == null) return;
        unavailableTitle.setText(title);
        unavailableMessage.setText(message);
        unavailable.setVisibility(View.VISIBLE);
        resume.setVisibility(View.GONE);
        if (web != null) web.setVisibility(View.INVISIBLE);
    }

    private void confirmReload() {
        new AlertDialog.Builder(this).setTitle("Reload the counter?")
                .setMessage("An unsaved basket may be lost. If a sale was interrupted, check Receipts after reloading before entering it again.")
                .setNegativeButton("Keep screen", null)
                .setPositiveButton("Reload", (dialog, which) -> {
                    pageReady = false;
                    pageFailed = false;
                    unavailable.setVisibility(View.GONE);
                    if (web == null) createWebView();
                    web.setVisibility(View.VISIBLE);
                    web.loadUrl(CounterOrigin.HOME);
                    updateConnection();
                }).show();
    }

    private void printReceipt() {
        if (!pageReady || web == null || !hasInternet() || !CounterOrigin.allowed(web.getUrl())) return;
        if (printJob != null && !(printJob.isCompleted() || printJob.isCancelled() || printJob.isFailed())) {
            Toast.makeText(this, "Finish or cancel the current print job first.", Toast.LENGTH_LONG).show();
            return;
        }
        // Read-only DOM check. No native interface is exposed to page JavaScript.
        web.evaluateJavascript("Boolean(document.querySelector('.lc-receipt'))", result -> {
            if (!"true".equals(result) || !pageReady || web == null || !CounterOrigin.allowed(web.getUrl())) {
                Toast.makeText(this, "Open Receipts and select a saved invoice, then tap Print in the top bar.", Toast.LENGTH_LONG).show();
                return;
            }
            PrintManager manager = (PrintManager) getSystemService(Context.PRINT_SERVICE);
            if (manager == null) {
                Toast.makeText(this, "Android printing is unavailable on this device.", Toast.LENGTH_LONG).show();
                return;
            }
            printJob = manager.print("Internext receipt", web.createPrintDocumentAdapter("Internext receipt"),
                    new PrintAttributes.Builder().setColorMode(PrintAttributes.COLOR_MODE_MONOCHROME).build());
        });
    }

    private void navigateBack() {
        if (web != null && web.canGoBack() && pageReady) web.goBack();
        else new AlertDialog.Builder(this).setTitle("Leave the counter?")
                .setMessage("An unsaved basket may be lost. Saved sales remain in Receipts.")
                .setNegativeButton("Stay", null).setPositiveButton("Leave", (dialog, which) -> finish()).show();
    }

    @Override public void onResume() { super.onResume(); updateConnection(); }
    @Override public void onPause() {
        CookieManager.getInstance().flush();
        super.onPause();
    }
    @Override public void onDestroy() {
        if (callbackRegistered && connectivity != null) connectivity.unregisterNetworkCallback(networkCallback);
        if (web != null) { page.removeView(web); web.destroy(); web = null; }
        super.onDestroy();
    }
    private Button button(String title) {
        Button button = new Button(this);
        button.setText(title);
        button.setAllCaps(false);
        button.setMinHeight(dp(48));
        button.setMinimumHeight(dp(48));
        return button;
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
