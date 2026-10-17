package com.run.client;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

public class MainActivity extends AppCompatActivity {
    private static final int REQUEST_SCREEN_CAPTURE = 1002;
    private static final int REQUEST_PERMISSIONS = 1003;

    private TextView tvStatus;
    private TextView tvDevice;
    private Button btnToggle;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        tvStatus = findViewById(R.id.tvStatus);
        tvDevice = findViewById(R.id.tvDevice);
        btnToggle = findViewById(R.id.btnToggle);

        String rawId = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
        if (rawId == null || rawId.isEmpty()) rawId = "device";
        String cleanId = rawId.length() > 8 ? rawId.substring(0, 8) : rawId;
        tvDevice.setText("Device ID: android-" + cleanId + "-" + Config.OS_SUFFIX);

        requestAppPermissions();
        updateUI();

        btnToggle.setOnClickListener(v -> {
            if (RunService.isRunning) {
                stopAgentService();
            } else {
                startAgentService();
            }
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateUI();
    }

    private void updateUI() {
        if (RunService.isRunning) {
            tvStatus.setText(R.string.status_running);
            tvStatus.setTextColor(ContextCompat.getColor(this, R.color.accent_green));
            btnToggle.setText(R.string.btn_stop);
            btnToggle.setBackgroundTintList(ContextCompat.getColorStateList(this, R.color.accent_red));
        } else {
            tvStatus.setText(R.string.status_stopped);
            tvStatus.setTextColor(ContextCompat.getColor(this, R.color.text_muted));
            btnToggle.setText(R.string.btn_start);
            btnToggle.setBackgroundTintList(ContextCompat.getColorStateList(this, R.color.accent_green));
        }
    }

    private void startAgentService() {
        MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mpm != null) {
            startActivityForResult(mpm.createScreenCaptureIntent(), REQUEST_SCREEN_CAPTURE);
        } else {
            Toast.makeText(this, "MediaProjection not supported", Toast.LENGTH_SHORT).show();
        }
    }

    private void stopAgentService() {
        Intent intent = new Intent(this, RunService.class);
        stopService(intent);
        RunService.isRunning = false;
        updateUI();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_SCREEN_CAPTURE) {
            if (resultCode == RESULT_OK && data != null) {
                Intent serviceIntent = new Intent(this, RunService.class);
                serviceIntent.putExtra("resultCode", resultCode);
                serviceIntent.putExtra("data", data);

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(serviceIntent);
                } else {
                    startService(serviceIntent);
                }

                updateUI();
                moveTaskToBack(true); // Hide to background
            } else {
                Toast.makeText(this, "Screen capture permission denied", Toast.LENGTH_SHORT).show();
            }
        }
    }

    private void requestAppPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_PERMISSIONS);
            }
        }
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.S_V2) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQUEST_PERMISSIONS);
            }
        }
    }
}
