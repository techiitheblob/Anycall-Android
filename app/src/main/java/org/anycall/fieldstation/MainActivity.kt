package org.anycall.fieldstation

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.tensorflow.lite.Interpreter
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.MappedByteBuffer
import java.nio.channels.FileChannel
import kotlin.math.sqrt

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private val FILE_CHOOSER_RESULT_CODE = 102
    private var tfliteInterpreter: Interpreter? = null
    private val tfliteLock = Any()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        requestPermissions()
        initBirdNetTflite()
        setupWebView()

        // Load local AnyCall v2 field station UI
        webView.loadUrl("file:///android_asset/public/index.html")
    }

    private fun loadModelFile(assetPath: String): MappedByteBuffer {
        val fileDescriptor = assets.openFd(assetPath)
        val inputStream = FileInputStream(fileDescriptor.fileDescriptor)
        val fileChannel = inputStream.channel
        return fileChannel.map(
            FileChannel.MapMode.READ_ONLY,
            fileDescriptor.startOffset,
            fileDescriptor.declaredLength
        )
    }

    private fun initBirdNetTflite() {
        Thread {
            try {
                val options = Interpreter.Options().apply {
                    setNumThreads(2)
                }
                val modelBuffer = loadModelFile("models/birdnet/BirdNET_V2.4_Emb1024.tflite")
                synchronized(tfliteLock) {
                    tfliteInterpreter = Interpreter(modelBuffer, options)
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }.start()
    }

    @Suppress("DEPRECATION")
    private fun setupWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.allowFileAccessFromFileURLs = true
        settings.allowUniversalAccessFromFileURLs = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW

        webView.addJavascriptInterface(AndroidBridge(), "AndroidBridge")
        webView.webViewClient = WebViewClient()
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                runOnUiThread {
                    request?.grant(request.resources)
                }
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                this@MainActivity.filePathCallback?.onReceiveValue(null)
                this@MainActivity.filePathCallback = filePathCallback
                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "audio/*"
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
                startActivityForResult(Intent.createChooser(intent, "Select Audio Recording"), FILE_CHOOSER_RESULT_CODE)
                return true
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == FILE_CHOOSER_RESULT_CODE) {
            val callback = filePathCallback ?: return
            var results: Array<Uri>? = null
            if (resultCode == Activity.RESULT_OK && data != null) {
                val clipData = data.clipData
                if (clipData != null) {
                    results = Array(clipData.itemCount) { i -> clipData.getItemAt(i).uri }
                } else {
                    data.data?.let { results = arrayOf(it) }
                }
            }
            callback.onReceiveValue(results)
            filePathCallback = null
        }
    }

    inner class AndroidBridge {
        @JavascriptInterface
        fun startBackgroundService() {
            this@MainActivity.startBackgroundService()
        }

        @JavascriptInterface
        fun stopBackgroundService() {
            this@MainActivity.stopBackgroundService()
        }

        @JavascriptInterface
        fun hasNativeBirdNet(): Boolean {
            synchronized(tfliteLock) {
                return tfliteInterpreter != null
            }
        }

        @JavascriptInterface
        fun extractBirdNetEmbedding(base64Float32Pcm: String): String {
            synchronized(tfliteLock) {
                val interp = tfliteInterpreter ?: return "[]"
                return try {
                    val rawBytes = Base64.decode(base64Float32Pcm, Base64.DEFAULT)
                    val floatBuf = ByteBuffer.wrap(rawBytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
                    val expectedSamples = 144000
                    val inputBuffer = ByteBuffer.allocateDirect(expectedSamples * 4).order(ByteOrder.nativeOrder())
                    val inFloats = inputBuffer.asFloatBuffer()
                    val count = minOf(expectedSamples, floatBuf.remaining())
                    for (i in 0 until count) {
                        inFloats.put(i, floatBuf.get(i))
                    }
                    for (i in count until expectedSamples) {
                        inFloats.put(i, 0f)
                    }

                    val outputArray = Array(1) { FloatArray(1024) }
                    interp.run(inputBuffer, outputArray)

                    val emb = outputArray[0]
                    var normSq = 0.0
                    for (v in emb) {
                        normSq += (v * v).toDouble()
                    }
                    val norm = sqrt(normSq).toFloat()
                    val sb = StringBuilder("[")
                    for (i in emb.indices) {
                        val v = if (norm > 1e-12f) emb[i] / norm else 0f
                        if (i > 0) sb.append(',')
                        sb.append(String.format(java.util.Locale.US, "%.5f", v))
                    }
                    sb.append("]")
                    sb.toString()
                } catch (e: Exception) {
                    e.printStackTrace()
                    "[]"
                }
            }
        }
    }

    private fun requestPermissions() {
        val permissions = mutableListOf(
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.INTERNET,
            Manifest.permission.ACCESS_NETWORK_STATE
        )

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        val missing = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), 101)
        }
    }

    fun startBackgroundService() {
        val intent = Intent(this, BioacousticListenerService::class.java).apply {
            action = BioacousticListenerService.ACTION_START
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    fun stopBackgroundService() {
        val intent = Intent(this, BioacousticListenerService::class.java).apply {
            action = BioacousticListenerService.ACTION_STOP
        }
        startService(intent)
    }

    override fun onDestroy() {
        synchronized(tfliteLock) {
            tfliteInterpreter?.close()
            tfliteInterpreter = null
        }
        super.onDestroy()
    }
}
