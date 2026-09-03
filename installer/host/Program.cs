using System;
using System.Windows.Forms;

namespace PowderToy3D
{
    internal static class Program
    {
        /// <summary>
        /// Entry point.
        ///   --smoke-test  opens the sandbox, checks the simulation really started on this machine,
        ///                 and exits 0 (ok) or non-zero - used by the build to prove the packaged
        ///                 program works on Windows.
        ///   --software    renders without the graphics card. Slow, but it gets the sandbox open on a
        ///                 machine whose driver is blocked or missing.
        /// </summary>
        [STAThread]
        private static int Main(string[] args)
        {
            bool smoke = Array.IndexOf(args, "--smoke-test") >= 0;
            // A smoke test on a build runner has no graphics card, so it always uses the slow path.
            // The smoke test used to force software rendering, on the reasoning that a build
            // runner has no graphics card. That made it useless for the failure it exists to
            // catch: on Windows the real path to the GPU is ANGLE translating the shaders to
            // HLSL for Direct3D's compiler, and SwiftShader shares none of that. A shader
            // that took Direct3D's compiler apart passed the smoke test every time. So the
            // smoke test now goes the ordinary way unless it is told otherwise, and the
            // packaging script runs it both ways.
            bool software = Array.IndexOf(args, "--software") >= 0;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            // The installer looks for this name so it can ask the user to close the app before upgrading.
            using (new System.Threading.Mutex(false, "PowderToy3DRunning"))
            using (var form = new MainForm(smoke, software))
            {
                Application.Run(form);
                return form.ExitCode;
            }
        }
    }
}
