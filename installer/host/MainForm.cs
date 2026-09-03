using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PowderToy3D
{
    /// <summary>The one window: a WebView2 control showing the single-file sandbox.</summary>
    internal sealed class MainForm : Form
    {
        private const string AppFileName = "Powder Toy 3D.html";
        private const string VirtualHost = "powder-toy-3d.app";

        private readonly WebView2 _web = new WebView2 { Dock = DockStyle.Fill };
        private readonly bool _smoke;
        private readonly bool _software;
        // Set once the drawing process has died, so the reload asks the page to stay small.
        private bool _safe;
        private readonly string _dataDir;
        private Timer _smokeWatchdog;

        private bool _fullScreen;
        private FormWindowState _preFullState;
        private FormBorderStyle _preFullBorder;
        private Rectangle _preFullBounds;

        public int ExitCode { get; private set; }

        public MainForm(bool smoke, bool software)
        {
            _smoke = smoke;
            _software = software;
            _dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Powder Toy 3D", "Data");
            Text = "Powder Toy 3D";
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { /* keep the default icon */ }
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(1360, 900);
            MinimumSize = new Size(760, 520);
            BackColor = Color.FromArgb(5, 8, 12);
            Controls.Add(_web);
            RestoreWindowBounds();
            Load += OnLoad;
            FormClosing += OnFormClosing;
        }

        private async void OnLoad(object sender, EventArgs e)
        {
            try
            {
                string appDir = AppDomain.CurrentDomain.BaseDirectory;
                string appFile = Path.Combine(appDir, AppFileName);
                if (!File.Exists(appFile))
                {
                    Fail(3, "The sandbox's main file is missing. Please install Powder Toy 3D again.");
                    return;
                }
                Directory.CreateDirectory(_dataDir);
                var options = new CoreWebView2EnvironmentOptions { Language = "en-GB" };
                if (_software)
                {
                    // No graphics card, or a blocked driver: draw with the CPU instead. Correct, but slow.
                    options.AdditionalBrowserArguments =
                        "--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --disable-gpu-watchdog";
                }
                var env = await CoreWebView2Environment.CreateAsync(null, _dataDir, options);
                await _web.EnsureCoreWebView2Async(env);
                var core = _web.CoreWebView2;
                // Right-drag orbits the camera and Ctrl+wheel pushes the brush deeper, so the
                // browser's own context menu and zoom must stay out of the way.
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsPasswordAutosaveEnabled = false;
                core.Settings.IsGeneralAutofillEnabled = false;
                // Left on: the README documents a window.PowderToy hatch for poking at the solver.
                core.Settings.AreDevToolsEnabled = true;
                core.SetVirtualHostNameToFolderMapping(VirtualHost, appDir, CoreWebView2HostResourceAccessKind.Allow);
                core.NewWindowRequested += (o, a) => { a.Handled = true; OpenExternally(a.Uri); };
                core.NavigationStarting += (o, a) =>
                {
                    // Anything that isn't our own page (web links) goes to Windows instead.
                    if (!a.Uri.StartsWith("https://" + VirtualHost + "/", StringComparison.OrdinalIgnoreCase))
                    {
                        a.Cancel = true;
                        OpenExternally(a.Uri);
                    }
                };
                core.ContainsFullScreenElementChanged += OnFullScreenElementChanged;
                // The page reports what it is doing through its title, and setting up the
                // graphics is the slow, risky part - a large ray-marching shader handed to
                // Direct3D's compiler. If that goes badly the page has drawn nothing, so the
                // title bar is the only thing anyone can see, and it needs to be worth
                // reading: "preparing the picture (21 of 29)" says where it stopped.
                core.DocumentTitleChanged += OnDocumentTitleChanged;
                core.NavigationCompleted += OnNavigationCompleted;
                core.ProcessFailed += OnProcessFailed;
                // Without a graphics card the medium preset's float textures are enough to lose
                // the drawing context before the sandbox has drawn anything, so start it small.
                // The page reads this from its own address bar.
                Navigate();
                if (_smoke)
                {
                    // Software rendering is slow; give it room, but never hang the build.
                    _smokeWatchdog = new Timer { Interval = 420000 };
                    _smokeWatchdog.Tick += (o, a) => Fail(4, "Smoke test timed out.");
                    _smokeWatchdog.Start();
                }
            }
            catch (WebView2RuntimeNotFoundException)
            {
                Fail(2, "This needs the Microsoft Edge WebView2 component, which is normally part of Windows.\n\nPlease run the Powder Toy 3D installer again - it adds the component if it is missing.");
            }
            catch (Exception ex) when (ex is BadImageFormatException || ex is DllNotFoundException || (ex.HResult == unchecked((int)0x8007000B)))
            {
                Fail(6, "Sorry - the sandbox couldn't start because a part of it doesn't match this computer.\n\nPlease download the latest installer and run it again.\n\n" + Diagnostics(ex));
            }
            catch (Exception ex)
            {
                Fail(6, "Sorry - the sandbox couldn't start.\n\n" + ex.Message + "\n\n" + Diagnostics(ex));
            }
        }

        /// <summary>
        /// The page has asked to go full screen, or to come back out of it - F11 in the sandbox
        /// calls requestFullscreen(). A WinForms host cannot see accelerator keys pressed inside
        /// the web content (AcceleratorKeyPressed lives on the controller, which the WinForms
        /// wrapper keeps to itself), so the page drives this and the window follows. It also means
        /// F11 behaves the same whether the file is opened in a browser or in this program.
        /// </summary>
        private void OnFullScreenElementChanged(object sender, object e)
        {
            bool wanted = _web.CoreWebView2 != null && _web.CoreWebView2.ContainsFullScreenElement;
            if (wanted != _fullScreen) SetFullScreen(wanted);
        }

        /// <summary>
        /// Point the window at the app file. Without a graphics card the middle preset's
        /// float textures are enough to lose the drawing context before the sandbox has
        /// drawn anything, and after a crash we come back deliberately small; the page
        /// reads both of these from its own address bar.
        /// </summary>
        private void Navigate()
        {
            string query = _safe ? "?quality=low&safe=1" : (_software ? "?quality=low" : "");
            _web.CoreWebView2.Navigate("https://" + VirtualHost + "/" + Uri.EscapeDataString(AppFileName) + query);
        }

        /// <summary>
        /// The part of WebView2 that does the drawing has died - almost always because the
        /// graphics driver was asked for more than it could finish, and Windows reset it.
        ///
        /// Closing the program here is the wrong answer: whatever caused it will do the
        /// same thing next time, so the person is left with a window that never opens. So
        /// the first failure reloads the page in safe mode, which starts on the smallest
        /// preset and stays there. Only a second failure gives up, because by then it is
        /// not something less detail is going to fix.
        /// </summary>
        private void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs e)
        {
            if (_smoke || _safe)
            {
                Fail(5, "Sorry - the sandbox stopped unexpectedly. Please open it again.");
                return;
            }
            _safe = true;
            MessageBox.Show(this,
                "The graphics card had trouble with that. Starting again with less detail.",
                "Powder Toy 3D", MessageBoxButtons.OK, MessageBoxIcon.Information);
            try { Navigate(); }
            catch { Fail(5, "Sorry - the sandbox stopped unexpectedly. Please open it again."); }
        }

        private void OnDocumentTitleChanged(object sender, object e)
        {
            string title = _web.CoreWebView2 == null ? null : _web.CoreWebView2.DocumentTitle;
            Text = string.IsNullOrWhiteSpace(title) ? "Powder Toy 3D" : title;
        }

        private void SetFullScreen(bool on)
        {
            if (on)
            {
                _preFullState = WindowState;
                _preFullBorder = FormBorderStyle;
                _preFullBounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                WindowState = FormWindowState.Normal;
                FormBorderStyle = FormBorderStyle.None;
                Bounds = Screen.FromControl(this).Bounds;
                _fullScreen = true;
            }
            else
            {
                FormBorderStyle = _preFullBorder;
                Bounds = _preFullBounds;
                WindowState = _preFullState;
                _fullScreen = false;
            }
        }

        private async void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (!e.IsSuccess)
            {
                Fail(7, "Sorry - the sandbox's page couldn't be shown (" + e.WebErrorStatus + "). Please install Powder Toy 3D again.");
                return;
            }
            if (!_smoke) return;
            try
            {
                // Wait for the sandbox to publish its hatch, then make it draw one cheap frame and
                // report what actually happened. This proves the shipped file parses, every shader
                // compiled and a frame reached the screen - not merely that a window opened.
                string status = "waiting";
                for (int i = 0; i < 240; i++)
                {
                    status = Unquote(await _web.CoreWebView2.ExecuteScriptAsync(StatusScript));
                    if (status.StartsWith("ready", StringComparison.Ordinal) || status.StartsWith("fail:", StringComparison.Ordinal)) break;
                    await Task.Delay(1000);
                }
                File.WriteAllText(Path.Combine(_dataDir, "smoke-test.txt"), status);
                ExitCode = status.StartsWith("ready", StringComparison.Ordinal) ? 0 : 1;
            }
            catch (Exception ex)
            {
                File.WriteAllText(Path.Combine(_dataDir, "smoke-test.txt"), ex.ToString());
                ExitCode = 8;
            }
            Close();
        }

        /// <summary>
        /// Runs inside the page. Returns "ready ..." once the simulation is up and a frame has been
        /// drawn, or "waiting"/"fail:..." otherwise.
        /// </summary>
        private const string StatusScript = @"
(function () {
  try {
    var boot = document.getElementById('boot');
    /* The same panel carries both 'still starting' and 'cannot start', so the mode has to
       be read too - otherwise a perfectly healthy startup is reported as a failure the
       moment it says what it is doing. */
    if (boot && !boot.hidden) {
      if (boot.dataset.mode === 'progress') return 'waiting ' + (boot.textContent || '').slice(0, 120);
      return 'fail:cannot-start ' + (boot.textContent || '').slice(0, 300);
    }
    var P = window.PowderToy;
    if (!P || !P.sim || !P.renderer) return 'waiting';
    P.app.halt = true;                 /* stop the loop so the build machine is not pegged */
    P.RENDER.caustics = false;
    P.RENDER.scale = 0.25;
    P.RENDER.surfSteps = 40;
    P.RENDER.shadowSteps = 6;
    P.controls.rescale();
    P.drawOnce(1.5, false);
    var gl = P.sim.gfx.gl;
    return 'ready programs=' + P.sim.gfx.programs.size
         + ' frames=' + P.renderer.frame
         + ' grid=' + P.sim.n.nx
         + ' specks=' + P.sim.used
         + ' glerror=' + gl.getError()
         + ' gpu=' + String(P.sim.gfx.renderer).slice(0, 80);
  } catch (err) {
    return 'fail:' + (err && err.message ? err.message : String(err));
  }
})()";

        /// <summary>ExecuteScriptAsync hands back a JSON value; our scripts always return a string.</summary>
        private static string Unquote(string json)
        {
            if (string.IsNullOrEmpty(json)) return "";
            if (json.Length >= 2 && json[0] == '"' && json[json.Length - 1] == '"')
            {
                return json.Substring(1, json.Length - 2)
                    .Replace("\\n", "\n").Replace("\\\"", "\"").Replace("\\\\", "\\");
            }
            return json;
        }

        /// <summary>One line of technical detail to quote if something goes wrong.</summary>
        private static string Diagnostics(Exception ex)
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory;
            string arch = RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant();
            bool loader = File.Exists(Path.Combine(dir, arch, "WebView2Loader.dll")) || File.Exists(Path.Combine(dir, "runtimes", "win-" + arch, "native", "WebView2Loader.dll"));
            return "(Details for support: " + arch + " program on " + RuntimeInformation.OSArchitecture.ToString().ToLowerInvariant() + " Windows, helper " + (loader ? "present" : "missing") + ", " + ex.GetType().Name + ")";
        }

        private static void OpenExternally(string uri)
        {
            if (string.IsNullOrEmpty(uri)) return;
            if (uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
                || uri.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase))
            {
                try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { /* ignore */ }
            }
        }

        private void Fail(int code, string message)
        {
            ExitCode = code;
            if (!_smoke) MessageBox.Show(this, message, "Powder Toy 3D", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            else
            {
                try { File.WriteAllText(Path.Combine(_dataDir, "smoke-test.txt"), message); } catch { /* nothing to do */ }
            }
            Close();
        }

        /// <summary>Nothing here is persisted, so closing is immediate - just remember the window.</summary>
        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (_smokeWatchdog != null) { _smokeWatchdog.Stop(); _smokeWatchdog.Dispose(); _smokeWatchdog = null; }
            if (!_fullScreen) SaveWindowBounds();
        }

        private string BoundsFile { get { return Path.Combine(_dataDir, "window.txt"); } }

        private void RestoreWindowBounds()
        {
            try
            {
                if (!File.Exists(BoundsFile)) return;
                var parts = File.ReadAllText(BoundsFile).Split(',');
                if (parts.Length < 5) return;
                var rect = new Rectangle(int.Parse(parts[0]), int.Parse(parts[1]), int.Parse(parts[2]), int.Parse(parts[3]));
                if (Screen.AllScreens.Length > 0 && Array.Exists(Screen.AllScreens, s => s.WorkingArea.IntersectsWith(rect)))
                {
                    StartPosition = FormStartPosition.Manual;
                    Bounds = rect;
                }
                if (parts[4] == "max") WindowState = FormWindowState.Maximized;
            }
            catch { /* use defaults */ }
        }

        private void SaveWindowBounds()
        {
            try
            {
                var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                Directory.CreateDirectory(_dataDir);
                File.WriteAllText(BoundsFile, string.Join(",", r.X, r.Y, r.Width, r.Height, WindowState == FormWindowState.Maximized ? "max" : "normal"));
            }
            catch { /* not important */ }
        }
    }
}
