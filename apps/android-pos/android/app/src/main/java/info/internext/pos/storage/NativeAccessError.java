package info.internext.pos.storage;

/** Stable non-sensitive errors only; never pass network bodies or credentials to the WebView. */
public final class NativeAccessError extends Exception {
    public final String code;
    public NativeAccessError(String code) { super(code); this.code=code; }
}
