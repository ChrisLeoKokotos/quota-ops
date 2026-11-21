param(
  [Parameter(Mandatory = $true)][string]$CommandLine,
  [Parameter(Mandatory = $true)][string]$WorkingDirectory,
  [int]$TimeoutSeconds = 600
)
# QuotaOps background collection on Windows: runs ONE collector worker on a
# separate desktop of the user's own window station. Windows created there
# never appear on, and cannot take focus from, the desktop the person uses.
#
# The worker runs inside a job object with KILL_ON_JOB_CLOSE: when this
# script ends for any reason (normal exit, timeout, QuotaOps Quit killing
# it), Windows ends the worker and every browser process it started.
#
# Nothing here changes the browser, its identity or any security setting.
# ASCII only: Windows PowerShell 5.1 misreads BOM-less UTF-8.
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class QuotaOpsHiddenDesktop {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
    IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr sa, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  public static string Run(string commandLine, string cwd, int timeoutMs) {
    string name = "QuotaOpsCollect-" + Guid.NewGuid().ToString("N").Substring(0, 12);
    // The desktop is created but never made the input desktop, so nothing on
    // it can be seen or receive the person's keyboard and mouse.
    IntPtr desk = CreateDesktopW(name, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000u, IntPtr.Zero);
    if (desk == IntPtr.Zero) return "ERROR create_desktop " + Marshal.GetLastWin32Error();
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) { CloseDesktop(desk); return "ERROR create_job"; }
    try {
      var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
        return "ERROR job_limits";
      var si = new STARTUPINFO();
      si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
      si.lpDesktop = "WinSta0\\" + name;
      PROCESS_INFORMATION pi;
      // CREATE_SUSPENDED | CREATE_NO_WINDOW: join the job before any code runs.
      if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false,
          0x00000004u | 0x08000000u, IntPtr.Zero, cwd, ref si, out pi))
        return "ERROR create_process " + Marshal.GetLastWin32Error();
      try {
        if (!AssignProcessToJobObject(job, pi.hProcess)) {
          TerminateProcess(pi.hProcess, 1);
          return "ERROR assign_job";
        }
        ResumeThread(pi.hThread);
        Console.Out.WriteLine("STARTED " + pi.dwProcessId);
        Console.Out.Flush();
        uint wait = WaitForSingleObject(pi.hProcess, (uint)timeoutMs);
        if (wait != 0) return "TIMEOUT";
        uint code; GetExitCodeProcess(pi.hProcess, out code);
        return "EXIT " + code;
      } finally {
        CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
      }
    } finally {
      CloseHandle(job); // KILL_ON_JOB_CLOSE ends anything still running
      CloseDesktop(desk);
    }
  }
}
"@
[QuotaOpsHiddenDesktop]::Run($CommandLine, $WorkingDirectory, $TimeoutSeconds * 1000)
