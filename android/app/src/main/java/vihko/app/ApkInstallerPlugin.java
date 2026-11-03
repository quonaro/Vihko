package vihko.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;

@CapacitorPlugin(
    name = "ApkInstaller",
    permissions = @Permission(
        alias = "notifications",
        strings = { Manifest.permission.POST_NOTIFICATIONS }
    )
)
public class ApkInstallerPlugin extends Plugin {
    private static final int PROGRESS_ID = 4201;
    private static final int DONE_ID = 4202;
    private static final String PROGRESS_CHANNEL = "update-progress";
    private static final String ALERT_CHANNEL = "update-alerts";
    private static final String APK_MIME = "application/vnd.android.package-archive";

    // Ask for POST_NOTIFICATIONS once per session; later calls resolve silently.
    private boolean permAsked = false;

    @Override
    public void load() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getContext().getSystemService(NotificationManager.class);
        // Progress updates are silent; the "downloaded" alert is not.
        nm.createNotificationChannel(new NotificationChannel(
            PROGRESS_CHANNEL, "Download progress", NotificationManager.IMPORTANCE_LOW));
        nm.createNotificationChannel(new NotificationChannel(
            ALERT_CHANNEL, "Updates", NotificationManager.IMPORTANCE_DEFAULT));
    }

    private boolean notificationsAllowed() {
        return Build.VERSION.SDK_INT < 33
            || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    /** True when the notification may be posted; otherwise requests permission once. */
    private boolean ensureNotifPermission(PluginCall call) {
        if (notificationsAllowed()) return true;
        if (!permAsked) {
            permAsked = true;
            requestPermissionForAlias("notifications", call, "notificationsPermCallback");
            return false;
        }
        call.resolve();
        return false;
    }

    @PermissionCallback
    private void notificationsPermCallback(PluginCall call) {
        if (!notificationsAllowed()) {
            call.resolve();
            return;
        }
        if ("notifyProgress".equals(call.getMethodName())) postProgress(call);
        else if ("notifyComplete".equals(call.getMethodName())) postComplete(call);
        else call.resolve();
    }

    private boolean canInstallApks() {
        return Build.VERSION.SDK_INT < 26
            || getContext().getPackageManager().canRequestPackageInstalls();
    }

    private void openSettingsScreen(Intent intent) {
        getContext().startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    private Intent installIntent(File apk) {
        Context ctx = getContext();
        Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
        return new Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, APK_MIME)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
    }

    @PluginMethod
    public void installState(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", canInstallApks());
        call.resolve(r);
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        openSettingsScreen(new Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:" + getContext().getPackageName())));
        call.resolve();
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        openSettingsScreen(new Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:" + getContext().getPackageName())));
        call.resolve();
    }

    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        File apk = path == null ? null : new File(path);
        if (apk == null || !apk.isFile()) {
            call.reject("APK file not found");
            return;
        }
        if (!canInstallApks()) {
            // The "install unknown apps" toggle lives in system settings —
            // send the user there; they retry once it's granted.
            openInstallSettings(call);
            return;
        }
        NotificationManagerCompat.from(getContext()).cancel(DONE_ID);
        getContext().startActivity(installIntent(apk));
        call.resolve();
    }

    @PluginMethod
    public void notifyProgress(PluginCall call) {
        if (!ensureNotifPermission(call)) return;
        postProgress(call);
    }

    private void postProgress(PluginCall call) {
        NotificationCompat.Builder b = new NotificationCompat.Builder(getContext(), PROGRESS_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(call.getString("title"))
            .setContentText(call.getString("body"))
            .setProgress(100, call.getInt("percent", 0), false)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setAutoCancel(false);
        NotificationManagerCompat.from(getContext()).notify(PROGRESS_ID, b.build());
        call.resolve();
    }

    @PluginMethod
    public void notifyComplete(PluginCall call) {
        if (!ensureNotifPermission(call)) return;
        postComplete(call);
    }

    private void postComplete(PluginCall call) {
        Context ctx = getContext();
        NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
        nm.cancel(PROGRESS_ID);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, ALERT_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(call.getString("title"))
            .setContentText(call.getString("body"))
            .setAutoCancel(true);
        String path = call.getString("path");
        File apk = path == null ? null : new File(path);
        if (apk != null && apk.isFile()) {
            PendingIntent pi = PendingIntent.getActivity(ctx, 0, installIntent(apk),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            b.setContentIntent(pi);
        }
        nm.notify(DONE_ID, b.build());
        call.resolve();
    }

    @PluginMethod
    public void notifyFailed(PluginCall call) {
        if (!ensureNotifPermission(call)) return;
        Context ctx = getContext();
        NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
        nm.cancel(PROGRESS_ID);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, ALERT_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle(call.getString("title"))
            .setContentText(call.getString("body"))
            .setAutoCancel(true);
        nm.notify(DONE_ID, b.build());
        call.resolve();
    }
}
