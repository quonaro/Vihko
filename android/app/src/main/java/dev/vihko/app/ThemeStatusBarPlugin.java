package dev.vihko.app;

import android.graphics.Color;
import android.view.Window;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ThemeStatusBar")
public class ThemeStatusBarPlugin extends Plugin {
    @PluginMethod
    public void setBackgroundColor(PluginCall call) {
        String color = call.getString("color");
        if (color == null || !color.matches("#[0-9A-Fa-f]{6}")) {
            call.reject("A six-digit hex color is required");
            return;
        }

        int parsedColor = Color.parseColor(color);
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            window.setStatusBarColor(parsedColor);
            window.getDecorView().setBackgroundColor(parsedColor);
            call.resolve();
        });
    }
}
