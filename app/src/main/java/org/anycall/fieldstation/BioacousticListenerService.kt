package org.anycall.fieldstation

import android.app.*
import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import java.io.File

class BioacousticListenerService : Service() {

    private var isListening = false
    private var recordingThread: Thread? = null
    private var wakeLock: PowerManager.WakeLock? = null

    companion object {
        const val CHANNEL_ID = "AnyCall_Background_Listener"
        const val NOTIFICATION_ID = 1001
        const val ACTION_START = "START_LISTENING"
        const val ACTION_STOP = "STOP_LISTENING"
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startContinuousMonitoring()
            ACTION_STOP -> stopContinuousMonitoring()
        }
        return START_STICKY
    }

    private fun startContinuousMonitoring() {
        if (isListening) return
        isListening = true

        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AnyCall::BioacousticWakeLock").apply {
            acquire(24 * 60 * 60 * 1000L) // Hold wake lock for 24h field operation
        }

        val notification = createNotification("24/7 Bioacoustic Streamer Active", "Monitoring acoustic environment...")
        startForeground(NOTIFICATION_ID, notification)

        recordingThread = Thread {
            val sampleRate = 48000
            val channelConfig = AudioFormat.CHANNEL_IN_MONO
            val audioFormat = AudioFormat.ENCODING_PCM_16BIT
            val minBufferSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)

            val audioRecord = try {
                AudioRecord(MediaRecorder.AudioSource.MIC, sampleRate, channelConfig, audioFormat, minBufferSize * 2)
            } catch (e: Exception) {
                null
            }

            if (audioRecord != null && audioRecord.state == AudioRecord.STATE_INITIALIZED) {
                audioRecord.startRecording()
                val buffer = ShortArray(sampleRate * 3) // 3-second buffer

                while (isListening) {
                    val read = audioRecord.read(buffer, 0, buffer.size)
                    if (read > 0) {
                        // Energy VAD Calculation
                        var sumSq = 0.0
                        for (i in 0 until read) {
                            val sample = buffer[i] / 32768.0
                            sumSq += sample * sample
                        }
                        val rms = Math.sqrt(sumSq / read)

                        if (rms > 0.006) {
                            // Vocalization Detected in Background
                            updateNotification("Vocal Activity Detected!", "RMS: ${String.format("%.4f", rms)}")
                        }
                    }
                }

                audioRecord.stop()
                audioRecord.release()
            }
        }
        recordingThread?.start()
    }

    private fun stopContinuousMonitoring() {
        isListening = false
        recordingThread?.interrupt()
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
        stopForeground(true)
        stopSelf()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "AnyCall 24/7 Field Station Listener",
                NotificationManager.IMPORTANCE_LOW
            )
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun createNotification(title: String, content: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(content)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun updateNotification(title: String, content: String) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, createNotification(title, content))
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stopContinuousMonitoring()
        super.onDestroy()
    }
}
