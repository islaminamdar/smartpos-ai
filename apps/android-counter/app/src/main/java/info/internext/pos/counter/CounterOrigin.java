package info.internext.pos.counter;

import java.net.URI;
import java.net.URISyntaxException;

/** A fixed HTTPS origin, never derived from an intent or remote configuration. */
final class CounterOrigin {
    static final String HOME = "https://pos.internext.info/counter";
    private CounterOrigin() {}

    static boolean allowed(String url) {
        if (url == null) return false;
        try {
            URI uri = new URI(url);
            return "https".equalsIgnoreCase(uri.getScheme())
                    && "pos.internext.info".equalsIgnoreCase(uri.getHost())
                    && uri.getRawUserInfo() == null
                    && (uri.getPort() == -1 || uri.getPort() == 443);
        } catch (URISyntaxException exception) {
            return false;
        }
    }
}
