package vihko.app;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.util.Locale;

public class MainActivity extends BridgeActivity {

    private String insetsCss = "";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ApkInstallerPlugin.class);
        super.onCreate(savedInstanceState);

        // The web layer draws its own status bar scrim over live content, so the
        // window runs edge to edge with transparent system bars. SystemBars'
        // insets handling is disabled in capacitor.config.ts — insets are
        // forwarded to CSS here instead of padding the web view.
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }

        View decor = window.getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(decor, (view, insets) -> {
            Insets bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            boolean keyboardVisible = insets.isVisible(WindowInsetsCompat.Type.ime());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());

            // Leave room for the keyboard by shrinking the view; the in-page
            // safe area drops to 0 so the layout doesn't count it twice.
            view.setPadding(0, 0, 0, keyboardVisible ? ime.bottom : 0);

            float density = getResources().getDisplayMetrics().density;
            insetsCss = String.format(
                Locale.US,
                "try{var s=document.documentElement.style;" +
                "s.setProperty('--safe-area-inset-top','%dpx');" +
                "s.setProperty('--safe-area-inset-right','%dpx');" +
                "s.setProperty('--safe-area-inset-bottom','%dpx');" +
                "s.setProperty('--safe-area-inset-left','%dpx');}catch(e){}",
                Math.round(bars.top / density),
                Math.round(bars.right / density),
                keyboardVisible ? 0 : Math.round(bars.bottom / density),
                Math.round(bars.left / density)
            );
            injectInsetsCss();

            return insets;
        });

        // A reload wipes the inline CSS variables, so re-apply them per page.
        getBridge().addWebViewListener(
            new WebViewListener() {
                @Override
                public void onPageCommitVisible(WebView view, String url) {
                    view.requestApplyInsets();
                    injectInsetsCss();
                }
            }
        );
    }

    private void injectInsetsCss() {
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView == null || insetsCss.isEmpty()) return;
        webView.post(() -> webView.evaluateJavascript(insetsCss, null));
    }
}
