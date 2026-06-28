const readline = require('readline');
const { spawn } = require('child_process');

// Setup readline interface for line-by-line stdin communication
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

// Setup logging helper to write to stderr so we don't interfere with stdout JSON-RPC
function log(msg) {
    console.error(`[Server] ${new Date().toISOString()} - ${msg}`);
}

// Helper to run PowerShell scripts via stdin
function runPowerShell(script) {
    return new Promise((resolve, reject) => {
        // Run powershell with -Command - to read script from stdin
        const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-']);
        let stdout = '';
        let stderr = '';
        
        ps.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        
        ps.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        ps.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(stderr.trim() || `PowerShell process exited with code ${code}`));
            } else {
                resolve(stdout.trim());
            }
        });
        
        ps.stdin.write(script);
        ps.stdin.end();
    });
}

// Tool declarations list conforming to the MCP schema
const toolsList = [
    {
        name: "get_system_status",
        description: "Get the current system resource usage status including average CPU load percentage, RAM (total, used, free, and percentage), C: Drive disk usage (total, used, free, and percentage), and system uptime.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "get_volume",
        description: "Get the current master audio volume level (0 to 100) and mute status.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "set_volume",
        description: "Set the system master audio volume level.",
        inputSchema: {
            type: "object",
            properties: {
                level: {
                    type: "number",
                    minimum: 0,
                    maximum: 100,
                    description: "Volume level target from 0 (mute/minimum) to 100 (maximum)."
                }
            },
            required: ["level"]
        }
    },
    {
        name: "set_mute",
        description: "Mute or unmute the system master audio.",
        inputSchema: {
            type: "object",
            properties: {
                mute: {
                    type: "boolean",
                    description: "True to mute the audio, false to unmute it."
                }
            },
            required: ["mute"]
        }
    },
    {
        name: "media_control",
        description: "Simulate media keys playback controls for applications like Spotify, YouTube (Chrome), or media players.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["play_pause", "next_track", "prev_track", "stop"],
                    description: "The media keyboard shortcut to simulate."
                }
            },
            required: ["action"]
        }
    },
    {
        name: "system_power_control",
        description: "Control Windows system power options (lock screen, sleep/suspend, schedule shutdown, schedule restart, abort shutdown).",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["lock", "sleep", "shutdown", "restart", "abort_shutdown"],
                    description: "The power operation to perform. Note: shutdown/restart will schedule the action in 60 seconds."
                }
            },
            required: ["action"]
        }
    },
    {
        name: "get_brightness",
        description: "Get the current screen brightness level (0 to 100) if supported (typically laptops).",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "set_brightness",
        description: "Set the screen brightness level (0 to 100) if supported.",
        inputSchema: {
            type: "object",
            properties: {
                level: {
                    type: "number",
                    minimum: 0,
                    maximum: 100,
                    description: "Brightness percentage from 0 to 100."
                }
            },
            required: ["level"]
        }
    },
    {
        name: "get_battery_status",
        description: "Get battery status, remaining power percentage, charging/AC state, and estimated runtime (supported on laptops).",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "get_top_processes",
        description: "Get the top 5 running processes consuming the most CPU percentage.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "get_clipboard",
        description: "Get the current text contents from the Windows clipboard.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "set_clipboard",
        description: "Write new text to the Windows clipboard.",
        inputSchema: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    description: "The text to copy to the clipboard."
                }
            },
            required: ["text"]
        }
    },
    {
        name: "open_url",
        description: "Open a specified web URL in the default or a specified custom web browser.",
        inputSchema: {
            type: "object",
            properties: {
                url: {
                    type: "string",
                    description: "The web address to open (e.g. 'https://github.com')."
                },
                browser: {
                    type: "string",
                    enum: ["chrome", "firefox", "edge", "brave"],
                    description: "Optional browser name to open the URL in."
                }
            },
            required: ["url"]
        }
    },
    {
        name: "send_keystrokes",
        description: "Send keyboard keystrokes to the currently active foreground window to interact with web pages or apps (e.g. typing text, pressing Enter/Tab).",
        inputSchema: {
            type: "object",
            properties: {
                keys: {
                    type: "array",
                    items: { type: "string" },
                    description: "An array of keys to send in sequence (e.g. ['^t', 'google.com', '{ENTER}', '{DELAY 1000}', 'Antigravity', '{ENTER}']). Use '^' for Ctrl, '%' for Alt, '+' for Shift. Use '{DELAY X}' to wait X milliseconds."
                }
            },
            required: ["keys"]
        }
    },
    {
        name: "launch_app",
        description: "Launch a Windows application or command (e.g. 'notepad', 'calc', 'explorer').",
        inputSchema: {
            type: "object",
            properties: {
                app: {
                    type: "string",
                    description: "The application name or command to execute."
                }
            },
            required: ["app"]
        }
    },
    {
        name: "get_network_info",
        description: "Get local network IP address, network adapter name, and external IP (if online).",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "show_desktop",
        description: "Minimize all active GUI windows to show the Windows desktop.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "get_gpu_info",
        description: "Get graphics card (GPU) details, driver version, memory, and status.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "get_audio_devices",
        description: "List available system audio output and input hardware devices.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "close_process",
        description: "Force close a running Windows process by name or PID (e.g. 'notepad' or '1244').",
        inputSchema: {
            type: "object",
            properties: {
                target: {
                    type: "string",
                    description: "The name of the process (e.g. 'notepad') or the PID number to kill."
                }
            },
            required: ["target"]
        }
    },
    {
        name: "empty_recycle_bin",
        description: "Empty the Windows Recycle Bin.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "get_disk_space",
        description: "Get space metrics (total, used, free) for all active storage drives.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "take_screenshot",
        description: "Capture a PNG screenshot of the primary display screen and save it locally.",
        inputSchema: {
            type: "object",
            properties: {
                filename: {
                    type: "string",
                    description: "Optional custom filename to save the screenshot. Defaults to 'screenshot.png' in the workspace directory."
                }
            }
        }
    },
    {
        name: "get_wifi_networks",
        description: "Scan and list nearby Wi-Fi network SSIDs and signal strengths.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "get_system_info",
        description: "Retrieve detailed static system hardware specifications (CPU model, motherboard, total physical RAM specs, OS version, and BIOS).",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "get_wifi_status",
        description: "Retrieve status details of the currently active Wi-Fi adapter connection (SSID, BSSID, Signal quality, Transmission rates).",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "get_network_latency",
        description: "Test network latency (ping response time and packet loss) to major targets (e.g. google.com).",
        inputSchema: {
            type: "object",
            properties: {
                target: {
                    type: "string",
                    description: "Optional custom address to ping. Defaults to '8.8.8.8'."
                }
            }
        }
    },
    {
        name: "clear_clipboard",
        description: "Clear all text contents currently on the Windows clipboard.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "get_dns_servers",
        description: "Retrieve configured DNS server IP addresses for the active network adapters.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "get_active_window",
        description: "Retrieve the title, process name, and PID of the currently focused foreground window on Windows.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    }
];

// Handles executing tools
async function callTool(name, args) {
    log(`Executing tool: ${name} with args ${JSON.stringify(args)}`);
    
    switch (name) {
        case "get_system_status": {
            const script = `
                $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
                if ($cpu -eq $null) { $cpu = (Get-CimInstance Win32_Processor).LoadPercentage }
                if ($cpu -eq $null) { $cpu = 0 }
                
                $os = Get-CimInstance Win32_OperatingSystem
                $ramTotal = [Math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
                $ramFree = [Math]::Round($os.FreePhysicalMemory / 1MB, 2)
                $ramUsed = [Math]::Round($ramTotal - $ramFree, 2)
                $ramPercent = [Math]::Round(($ramUsed / $ramTotal) * 100, 2)
                
                $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
                $diskTotal = [Math]::Round($disk.Size / 1GB, 2)
                $diskFree = [Math]::Round($disk.FreeSpace / 1GB, 2)
                $diskUsed = [Math]::Round($diskTotal - $diskFree, 2)
                $diskPercent = [Math]::Round(($diskUsed / $diskTotal) * 100, 2)
                
                $uptime = (Get-Date) - $os.LastBootUpTime
                $uptimeStr = "$($uptime.Days)d $($uptime.Hours)h $($uptime.Minutes)m"
                
                $result = @{
                    cpuPercent = [Math]::Round($cpu, 1)
                    ram = @{
                        totalGB = $ramTotal
                        usedGB = $ramUsed
                        freeGB = $ramFree
                        percent = $ramPercent
                    }
                    disk = @{
                        totalGB = $diskTotal
                        usedGB = $diskUsed
                        freeGB = $diskFree
                        percent = $diskPercent
                    }
                    uptime = $uptimeStr
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const status = JSON.parse(out);
            return `System Status:
- CPU Load: ${status.cpuPercent}%
- RAM Usage: ${status.ram.percent}% (${status.ram.usedGB} GB / ${status.ram.totalGB} GB)
- Disk C: Usage: ${status.disk.percent}% (${status.disk.usedGB} GB / ${status.disk.totalGB} GB)
- System Uptime: ${status.uptime}`;
        }
        
        case "get_volume": {
            const script = `
                $AudioCode = @"
                using System;
                using System.Runtime.InteropServices;
                [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
                public interface IAudioEndpointVolume {
                    int f(); int g(); int h(); int i();
                    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
                    int j();
                    int GetMasterVolumeLevelScalar(out float pfLevel);
                    int k(); int l(); int m(); int n();
                    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
                    int GetMute(out bool pbMute);
                }
                [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
                public interface IMMDevice { int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
                [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
                public interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
                [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumeratorComObject { }
                public class Audio {
                    private static IAudioEndpointVolume Vol() {
                        var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
                        IMMDevice dev = null;
                        enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
                        IAudioEndpointVolume epv = null;
                        var epvid = typeof(IAudioEndpointVolume).GUID;
                        dev.Activate(ref epvid, 23, 0, out epv);
                        return epv;
                    }
                    public static float GetVolume() {
                        float val = 0;
                        Vol().GetMasterVolumeLevelScalar(out val);
                        return val;
                    }
                    public static bool GetMute() {
                        bool mute = false;
                        Vol().GetMute(out mute);
                        return mute;
                    }
                }
"@
                Add-Type -TypeDefinition $AudioCode -ErrorAction SilentlyContinue
                $result = @{
                    volume = [Math]::Round([Audio]::GetVolume() * 100)
                    muted = [Audio]::GetMute()
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            return `System Volume: ${data.volume}% (Muted: ${data.muted})`;
        }
        
        case "set_volume": {
            const level = Number(args.level);
            if (isNaN(level) || level < 0 || level > 100) {
                throw new Error("Invalid volume level. Must be between 0 and 100.");
            }
            const scalar = (level / 100).toFixed(4);
            const script = `
                $AudioCode = @"
                using System;
                using System.Runtime.InteropServices;
                [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
                public interface IAudioEndpointVolume {
                    int f(); int g(); int h(); int i();
                    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
                    int j();
                    int GetMasterVolumeLevelScalar(out float pfLevel);
                    int k(); int l(); int m(); int n();
                    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
                    int GetMute(out bool pbMute);
                }
                [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
                public interface IMMDevice { int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
                [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
                public interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
                [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumeratorComObject { }
                public class Audio {
                    private static IAudioEndpointVolume Vol() {
                        var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
                        IMMDevice dev = null;
                        enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
                        IAudioEndpointVolume epv = null;
                        var epvid = typeof(IAudioEndpointVolume).GUID;
                        dev.Activate(ref epvid, 23, 0, out epv);
                        return epv;
                    }
                    public static void SetVolume(float level) {
                        Vol().SetMasterVolumeLevelScalar(level, Guid.Empty);
                    }
                }
"@
                Add-Type -TypeDefinition $AudioCode -ErrorAction SilentlyContinue
                [Audio]::SetVolume(${scalar})
            `;
            await runPowerShell(script);
            return `Volume successfully set to ${level}%.`;
        }
        
        case "set_mute": {
            const mute = !!args.mute;
            const psBool = mute ? '$true' : '$false';
            const script = `
                $AudioCode = @"
                using System;
                using System.Runtime.InteropServices;
                [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
                public interface IAudioEndpointVolume {
                    int f(); int g(); int h(); int i();
                    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
                    int j();
                    int GetMasterVolumeLevelScalar(out float pfLevel);
                    int k(); int l(); int m(); int n();
                    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
                    int GetMute(out bool pbMute);
                }
                [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
                public interface IMMDevice { int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
                [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
                public interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
                [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumeratorComObject { }
                public class Audio {
                    private static IAudioEndpointVolume Vol() {
                        var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
                        IMMDevice dev = null;
                        enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
                        IAudioEndpointVolume epv = null;
                        var epvid = typeof(IAudioEndpointVolume).GUID;
                        dev.Activate(ref epvid, 23, 0, out epv);
                        return epv;
                    }
                    public static void SetMute(bool mute) {
                        Vol().SetMute(mute, Guid.Empty);
                    }
                }
"@
                Add-Type -TypeDefinition $AudioCode -ErrorAction SilentlyContinue
                [Audio]::SetMute(${psBool})
            `;
            await runPowerShell(script);
            return `System audio has been ${mute ? 'muted' : 'unmuted'}.`;
        }
        
        case "media_control": {
            const action = args.action;
            let vk = 0;
            if (action === "play_pause") vk = 179;      // 0xB3
            else if (action === "next_track") vk = 176;  // 0xB0
            else if (action === "prev_track") vk = 177;  // 0xB1
            else if (action === "stop") vk = 178;        // 0xB2
            else throw new Error(`Unknown media action: ${action}`);
            
            const script = `
                $Code = @"
                using System;
                using System.Runtime.InteropServices;
                public class Keyboard {
                    [DllImport("user32.dll")]
                    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
                }
"@
                Add-Type -TypeDefinition $Code -ErrorAction SilentlyContinue
                [Keyboard]::keybd_event(${vk}, 0, 0, [UIntPtr]::Zero)
                [Keyboard]::keybd_event(${vk}, 0, 2, [UIntPtr]::Zero)
            `;
            await runPowerShell(script);
            return `Media action '${action}' successfully triggered.`;
        }
        
        case "system_power_control": {
            const action = args.action;
            let script = '';
            let msg = '';
            if (action === "lock") {
                script = 'rundll32.exe user32.dll,LockWorkStation';
                msg = "Workstation locked successfully.";
            } else if (action === "sleep") {
                script = `
                    Add-Type -Assembly System.Windows.Forms -ErrorAction SilentlyContinue
                    [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)
                `;
                msg = "System put to sleep successfully.";
            } else if (action === "shutdown") {
                script = 'shutdown.exe /s /t 60';
                msg = "Shutdown scheduled in 60 seconds. Use action 'abort_shutdown' to cancel.";
            } else if (action === "restart") {
                script = 'shutdown.exe /r /t 60';
                msg = "Restart scheduled in 60 seconds. Use action 'abort_shutdown' to cancel.";
            } else if (action === "abort_shutdown") {
                script = 'shutdown.exe /a';
                msg = "Scheduled power actions aborted successfully.";
            } else {
                throw new Error(`Unknown power action: ${action}`);
            }
            await runPowerShell(script);
            return msg;
        }
        
        case "get_brightness": {
            const script = `
                try {
                    $brightnessObj = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop
                    $result = @{
                        supported = $true
                        brightness = $brightnessObj.CurrentBrightness
                    }
                } catch {
                    $result = @{
                        supported = $false
                        brightness = $null
                    }
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            if (!data.supported) {
                return "Screen brightness control is not supported on this device (it might be a Desktop PC without WMI monitor integration).";
            }
            return `Current Screen Brightness: ${data.brightness}%`;
        }
        
        case "set_brightness": {
            const level = Number(args.level);
            if (isNaN(level) || level < 0 || level > 100) {
                throw new Error("Invalid brightness level. Must be between 0 and 100.");
            }
            const script = `
                try {
                    $methods = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop
                    $methods.WmiSetBrightness(1, ${level})
                    $result = @{ success = $true }
                } catch {
                    $result = @{ success = $false; error = $_.Exception.Message }
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            if (!data.success) {
                throw new Error(`Failed to set screen brightness: ${data.error || 'Control not supported'}`);
            }
            return `Screen brightness set to ${level}% successfully.`;
        }
        
        case "get_battery_status": {
            const script = `
                $battery = Get-CimInstance -ClassName Win32_Battery
                if ($battery) {
                    $statusMap = @{
                        1 = "Discharging"
                        2 = "AC power (Fully charged)"
                        3 = "Fully Charged"
                        4 = "Low"
                        5 = "Critical"
                        6 = "Charging"
                        7 = "Charging and High"
                        8 = "Charging and Low"
                        9 = "Charging and Critical"
                        10 = "Undefined"
                        11 = "Partially charged"
                    }
                    $statusStr = $statusMap[[int]$battery.BatteryStatus]
                    if (-not $statusStr) { $statusStr = "Unknown" }
                    $result = @{
                        detected = $true
                        percent = $battery.EstimatedChargeRemaining
                        status = $statusStr
                        remainingMinutes = $battery.EstimatedRunTime
                    }
                } else {
                    $result = @{
                        detected = $false
                        percent = $null
                        status = "No battery detected (likely a desktop PC)"
                        remainingMinutes = $null
                    }
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            if (!data.detected) {
                return "Battery status: No battery detected (this appears to be a desktop PC running on constant AC power).";
            }
            const runtimeStr = data.remainingMinutes ? `, Estimated remaining time: ${data.remainingMinutes} minutes` : '';
            return `Battery Status: ${data.percent}% charge (${data.status})${runtimeStr}.`;
        }
        
        case "get_top_processes": {
            const script = `
                $processes = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } | Sort-Object PercentProcessorTime -Descending | Select-Object -First 5 -Property Name, IDProcess, PercentProcessorTime
                $list = @()
                foreach ($p in $processes) {
                    $list += @{
                        name = $p.Name
                        pid = $p.IDProcess
                        cpuPercent = $p.PercentProcessorTime
                    }
                }
                $list | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const list = JSON.parse(out);
            if (!Array.isArray(list) || list.length === 0) {
                return "Could not retrieve process list or no active processes found.";
            }
            let responseText = "Top 5 CPU consuming processes:\n";
            list.forEach((p, idx) => {
                responseText += `${idx + 1}. Process: ${p.name} (PID: ${p.pid}) - CPU Load: ${p.cpuPercent}%\n`;
            });
            return responseText.trim();
        }
        
        case "get_clipboard": {
            const script = `
                try {
                    $clip = Get-Clipboard -Raw -ErrorAction Stop
                    if ($clip) {
                        $result = @{ success = $true; text = $clip }
                    } else {
                        $result = @{ success = $true; text = "" }
                    }
                } catch {
                    $result = @{ success = $false; error = $_.Exception.Message }
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            if (!data.success) {
                throw new Error(`Failed to read clipboard: ${data.error}`);
            }
            return data.text ? `Clipboard content:\n"${data.text}"` : "Clipboard is empty.";
        }
        
        case "set_clipboard": {
            const text = args.text || "";
            const script = `
                try {
                    Set-Clipboard -Value @'
${text.replace(/'/g, "''")}
'@ -ErrorAction Stop
                    $result = @{ success = $true }
                } catch {
                    $result = @{ success = $false; error = $_.Exception.Message }
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            if (!data.success) {
                throw new Error(`Failed to set clipboard: ${data.error}`);
            }
            return "Text copied to clipboard successfully.";
        }
        
        case "open_url": {
            let url = args.url;
            if (!/^https?:\/\//i.test(url)) {
                url = "https://" + url;
            }
            const browserName = args.browser || "";
            const script = `
                try {
                    $browser = "${browserName}"
                    $url = "${url.replace(/"/g, '`"')}"
                    if ($browser) {
                        $paths = @()
                        if ($browser -eq "chrome") {
                            $paths = @(
                                "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe",
                                "\${env:ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe",
                                "$env:LocalAppData\\Google\\Chrome\\Application\\chrome.exe"
                            )
                        } elseif ($browser -eq "firefox") {
                            $paths = @(
                                "$env:ProgramFiles\\Mozilla Firefox\\firefox.exe",
                                "\${env:ProgramFiles(x86)}\\Mozilla Firefox\\firefox.exe"
                            )
                        } elseif ($browser -eq "edge") {
                            $paths = @(
                                "\${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe",
                                "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe"
                            )
                        } elseif ($browser -eq "brave") {
                            $paths = @(
                                "$env:ProgramFiles\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
                                "\${env:ProgramFiles(x86)}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
                                "$env:LocalAppData\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
                            )
                        }
                        
                        $found = $null
                        foreach ($p in $paths) {
                            if (Test-Path $p) {
                                $found = $p
                                break
                            }
                        }
                        
                        if ($found) {
                            Start-Process $found -ArgumentList $url -ErrorAction Stop
                        } else {
                            Start-Process $url -ErrorAction Stop
                        }
                    } else {
                        Start-Process $url -ErrorAction Stop
                    }
                    $result = @{ success = $true }
                } catch {
                    $result = @{ success = $false; error = $_.Exception.Message }
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            if (!data.success) {
                throw new Error(`Failed to open URL: ${data.error}`);
            }
            return `Successfully opened URL in browser: ${url}`;
        }
        
        case "send_keystrokes": {
            const keys = args.keys;
            if (!Array.isArray(keys) || keys.length === 0) {
                throw new Error("Missing or invalid 'keys' parameter. Must be a non-empty array of strings.");
            }
            
            const psArray = keys.map(k => `"${k.replace(/"/g, '`"').replace(/\$/g, '`$')}"`).join(", ");
            const script = `
                try {
                    $keys = @(${psArray})
                    $wshell = New-Object -ComObject WScript.Shell
                    foreach ($key in $keys) {
                        if ($key -match '^\\{DELAY\\s+(\\d+)\\}$') {
                            $delay = [int]$Matches[1]
                            Start-Sleep -Milliseconds $delay
                        } else {
                            $wshell.SendKeys($key)
                            Start-Sleep -Milliseconds 150
                        }
                    }
                    $result = @{ success = $true }
                } catch {
                    $result = @{ success = $false; error = $_.Exception.Message }
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            if (!data.success) {
                throw new Error(`Failed to send keystrokes: ${data.error}`);
            }
            return "Successfully sent keystrokes to active window.";
        }
        
        case "launch_app": {
            const app = args.app;
            const script = `
                try {
                    Start-Process "${app.replace(/"/g, '`"')}" -ErrorAction Stop
                    $result = @{ success = $true }
                } catch {
                    $result = @{ success = $false; error = $_.Exception.Message }
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            if (!data.success) {
                throw new Error(`Failed to launch application: ${data.error}`);
            }
            return `Successfully launched application: ${app}`;
        }
        
        case "get_network_info": {
            const script = `
                try {
                    $localIps = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -Property IPAddress, InterfaceAlias
                    $localList = @()
                    foreach ($ip in $localIps) {
                        $localList += @{ ip = $ip.IPAddress; adapter = $ip.InterfaceAlias }
                    }
                    
                    $wifi = (netsh wlan show interfaces) | Select-String -Pattern '^\\s+SSID\\s+:\\s+(.+)'
                    $ssid = $null
                    if ($wifi) {
                        $ssid = $wifi.Matches.Groups[1].Value.Trim()
                    }
                    
                    $external = $null
                    try {
                        $external = (Invoke-RestMethod -Uri "https://api.ipify.org" -TimeoutSec 2).Trim()
                    } catch {}
                    
                    $result = @{
                        success = $true
                        local = $localList
                        wifi = $ssid
                        external = $external
                    }
                } catch {
                    $result = @{ success = $false; error = $_.Exception.Message }
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            if (!data.success) {
                throw new Error(`Failed to read network info: ${data.error}`);
            }
            let details = "Network Information:\\n";
            if (data.local && data.local.length > 0) {
                details += "- Local IPs:\\n";
                data.local.forEach(l => {
                    details += "  * " + l.ip + " (" + l.adapter + ")\\n";
                });
            } else {
                details += "- Local IP: Disconnected / Not found\\n";
            }
            if (data.wifi) {
                details += "- Wi-Fi Network (SSID): " + data.wifi + "\\n";
            }
            if (data.external) {
                details += "- External IP Address: " + data.external + "\\n";
            } else {
                details += "- External IP Address: Offline / Failed to resolve\\n";
            }
            return details.trim();
        }
        
        case "show_desktop": {
            const script = `
                try {
                    $shell = New-Object -ComObject Shell.Application
                    $shell.MinimizeAll()
                    $result = @{ success = $true }
                } catch {
                    $result = @{ success = $false; error = $_.Exception.Message }
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            if (!data.success) {
                throw new Error(`Failed to minimize windows: ${data.error}`);
            }
            return "All active windows minimized to show desktop.";
        }
        
        case "get_gpu_info": {
            const script = `
                try {
                    $gpus = Get-CimInstance Win32_VideoController
                    $list = @()
                    foreach ($g in $gpus) {
                        $list += @{
                            name = $g.Name
                            driverVersion = $g.DriverVersion
                            ramGB = if ($g.AdapterRAM) { [Math]::Round($g.AdapterRAM / 1GB, 2) } else { $null }
                            status = $g.Status
                        }
                    }
                    $result = @{ success = $true; list = $list }
                } catch {
                    $result = @{ success = $false; error = $_.Exception.Message }
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            if (!data.success) {
                throw new Error(`Failed to read GPU info: ${data.error}`);
            }
            if (!data.list || data.list.length === 0) {
                return "No GPU controllers detected.";
            }
            let text = "GPU Information:\\n";
            data.list.forEach((gpu, idx) => {
                const ram = gpu.ramGB !== null ? ", VRAM: " + gpu.ramGB + " GB" : "";
                text += (idx + 1) + ". GPU: " + gpu.name + " (Driver: " + gpu.driverVersion + ram + ", Status: " + gpu.status + ")\\n";
            });
            return text.trim();
        }
        
        case "get_audio_devices": {
            const script = `
                try {
                    $devices = Get-CimInstance Win32_SoundDevice
                    $list = @()
                    foreach ($d in $devices) {
                        $list += @{
                            name = $d.Name
                            status = $d.Status
                            manufacturer = $d.Manufacturer
                        }
                    }
                    $result = @{ success = $true; list = $list }
                } catch {
                    $result = @{ success = $false; error = $_.Exception.Message }
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            if (!data.success) {
                throw new Error(`Failed to read audio devices: ${data.error}`);
            }
            if (!data.list || data.list.length === 0) {
                return "No audio sound devices detected.";
            }
            let text = "Audio Devices:\\n";
            data.list.forEach((dev, idx) => {
                text += (idx + 1) + ". Name: " + dev.name + " (Manufacturer: " + (dev.manufacturer || "Unknown") + ", Status: " + dev.status + ")\\n";
            });
            return text.trim();
        }
        
        case "close_process": {
            const target = args.target;
            if (!target) {
                throw new Error("Missing 'target' parameter specifying process name or PID.");
            }
            const script = `
                try {
                    if ("${target}" -match '^\\d+$') {
                        Stop-Process -Id [int]"${target}" -Force -ErrorAction Stop
                    } else {
                        Stop-Process -Name "${target}" -Force -ErrorAction Stop
                    }
                    $result = @{ success = $true }
                } catch {
                    $result = @{ success = $false; error = $_.Exception.Message }
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            if (!data.success) {
                throw new Error(`Failed to close process: ${data.error}`);
            }
            return "Successfully closed process matching: " + target;
        }
        
        case "empty_recycle_bin": {
            const { exec } = require('child_process');
            const fs = require('fs');
            
            const driveLetters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
            for (const letter of driveLetters) {
                const binPath = `${letter}:\\$Recycle.Bin`;
                try {
                    if (fs.existsSync(binPath)) {
                        exec(`rd /s /q "${binPath}"`);
                    }
                } catch (e) {
                    // Ignore checking errors on locked/protected drives
                }
            }
            return "Successfully started emptying the Windows Recycle Bin in the background.";
        }
        
        case "get_disk_space": {
            const script = `
                $disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3"
                $diskList = @()
                foreach ($disk in $disks) {
                    $total = [Math]::Round($disk.Size / 1GB, 2)
                    $free = [Math]::Round($disk.FreeSpace / 1GB, 2)
                    $used = [Math]::Round($total - $free, 2)
                    $percent = [Math]::Round(($used / $total) * 100, 2)
                    $diskList += @{
                        drive = $disk.DeviceID
                        totalGB = $total
                        usedGB = $used
                        freeGB = $free
                        percentUsed = $percent
                    }
                }
                $result = @{ list = $diskList }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            let text = "Storage Disk Space:\n";
            data.list.forEach((disk) => {
                text += "- Drive " + disk.drive + " -> Total: " + disk.totalGB + " GB, Used: " + disk.usedGB + " GB (" + disk.percentUsed + "%), Free: " + disk.freeGB + " GB\n";
            });
            return text.trim();
        }
        
        case "take_screenshot": {
            const filename = args.filename || "screenshot.png";
            const path = require('path');
            const targetPath = path.resolve(process.cwd(), filename);
            
            const script = `
                try {
                    Add-Type -AssemblyName System.Windows.Forms
                    Add-Type -AssemblyName System.Drawing
                    $screen = [System.Windows.Forms.Screen]::PrimaryScreen
                    $bitmap = New-Object System.Drawing.Bitmap $screen.Bounds.Width, $screen.Bounds.Height
                    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
                    $graphics.CopyFromScreen($screen.Bounds.X, $screen.Bounds.Y, 0, 0, $screen.Bounds.Size)
                    $bitmap.Save("${targetPath.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)
                    $graphics.Dispose()
                    $bitmap.Dispose()
                    $result = @{ success = $true }
                } catch {
                    $result = @{ success = $false; error = $_.Exception.Message }
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            if (!data.success) {
                throw new Error(`Failed to take screenshot: ${data.error}`);
            }
            return "Screenshot successfully captured and saved to: " + targetPath;
        }
        
        case "get_wifi_networks": {
            const script = `
                try {
                    $networks = netsh wlan show networks mode=bssid
                    $result = @{ success = $true; output = ($networks -join "\`n") }
                } catch {
                    $result = @{ success = $false; error = $_.Exception.Message }
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            if (!data.success) {
                throw new Error(`Failed to scan Wi-Fi networks: ${data.error}`);
            }
            
            const lines = data.output.split('\n');
            let currentSsid = "";
            const wifiList = [];
            lines.forEach(line => {
                const matchSsid = line.match(/^SSID\s+\d+\s+:\s+(.*)$/);
                if (matchSsid) {
                    currentSsid = matchSsid[1].trim();
                }
                const matchSignal = line.match(/^\s+Signal\s+:\s+(\d+)%/);
                if (matchSignal && currentSsid) {
                    wifiList.push({ ssid: currentSsid, signal: matchSignal[1] });
                    currentSsid = "";
                }
            });
            
            if (wifiList.length === 0) {
                return "No nearby Wi-Fi networks found, or Wi-Fi adapter is disabled.";
            }
            
            let text = "Nearby Wi-Fi Networks:\n";
            const unique = [];
            wifiList.forEach(w => {
                if (!unique.some(x => x.ssid === w.ssid)) {
                    unique.push(w);
                }
            });
            unique.forEach((w, idx) => {
                text += (idx + 1) + ". SSID: \"" + w.ssid + "\" (Signal: " + w.signal + "%)\n";
            });
            return text.trim();
        }
        
        case "get_system_info": {
            const script = `
                $os = Get-CimInstance Win32_OperatingSystem
                $cpu = Get-CimInstance Win32_Processor
                $bios = Get-CimInstance Win32_Bios
                $motherboard = Get-CimInstance Win32_BaseBoard
                $ram = Get-CimInstance Win32_PhysicalMemory
                
                $ramTotalBytes = 0
                $ramDetails = @()
                foreach ($mem in $ram) {
                    $ramTotalBytes += $mem.Capacity
                    $ramDetails += @{
                        speedMHz = $mem.Speed
                        capacityGB = [Math]::Round($mem.Capacity / 1GB, 1)
                        manufacturer = $mem.Manufacturer
                    }
                }
                
                $result = @{
                    osName = $os.Caption
                    osVersion = $os.Version
                    osArchitecture = $os.OSArchitecture
                    cpuName = $cpu.Name
                    cpuCores = $cpu.NumberOfCores
                    cpuLogical = $cpu.NumberOfLogicalProcessors
                    biosVersion = $bios.SMBIOSBIOSVersion
                    motherboardManufacturer = $motherboard.Manufacturer
                    motherboardProduct = $motherboard.Product
                    ramTotalGB = [Math]::Round($ramTotalBytes / 1GB, 1)
                    ramModules = $ramDetails
                }
                $result | ConvertTo-Json
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            let text = `System Hardware Info:\n`;
            text += `- Operating System: ${data.osName} (${data.osArchitecture}, Version: ${data.osVersion})\n`;
            text += `- Processor: ${data.cpuName} (Cores: ${data.cpuCores}, Logical: ${data.cpuLogical})\n`;
            text += `- Motherboard: ${data.motherboardManufacturer} ${data.motherboardProduct}\n`;
            text += `- BIOS: Version ${data.biosVersion}\n`;
            text += `- Total Memory: ${data.ramTotalGB} GB\n`;
            if (Array.isArray(data.ramModules)) {
                data.ramModules.forEach((m, i) => {
                    text += `  * Slot ${i + 1}: ${m.capacityGB} GB (Speed: ${m.speedMHz} MHz, Manufacturer: ${m.manufacturer || "Unknown"})\n`;
                });
            } else if (data.ramModules) {
                text += `  * Slot 1: ${data.ramModules.capacityGB} GB (Speed: ${data.ramModules.speedMHz} MHz, Manufacturer: ${data.ramModules.manufacturer || "Unknown"})\n`;
            }
            return text.trim();
        }
        
        case "get_wifi_status": {
            const script = `
                try {
                    $output = netsh wlan show interfaces
                    $result = @{ success = $true; output = ($output -join "\`n") }
                } catch {
                    $result = @{ success = $false; error = $_.Exception.Message }
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            if (!data.success) {
                throw new Error(`Failed to retrieve Wi-Fi status: ${data.error}`);
            }
            return data.output.trim();
        }
        
        case "get_network_latency": {
            const target = args.target || "8.8.8.8";
            const script = `
                try {
                    $ping = Test-Connection -ComputerName "${target}" -Count 3 -ErrorAction Stop
                    $avgTime = ($ping | Measure-Object -Property ResponseTime -Average).Average
                    $result = @{ success = $true; averageMs = [Math]::Round($avgTime, 1); received = $ping.Count }
                } catch {
                    $result = @{ success = $false; error = $_.Exception.Message }
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            if (!data.success) {
                return `Failed to ping target '${target}': ${data.error}`;
            }
            return `Ping latency results to '${target}':\n- Average response time: ${data.averageMs} ms\n- Packets received: ${data.received}/3`;
        }
        
        case "clear_clipboard": {
            const script = `
                try {
                    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
                    [System.Windows.Forms.Clipboard]::Clear()
                    $result = @{ success = $true }
                } catch {
                    $result = @{ success = $false; error = $_.Exception.Message }
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            if (!data.success) {
                throw new Error(`Failed to clear clipboard: ${data.error}`);
            }
            return "Windows clipboard has been successfully cleared.";
        }
        
        case "get_dns_servers": {
            const script = `
                try {
                    $dns = Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object ServerAddresses -ne $null
                    $list = @()
                    foreach ($d in $dns) {
                        $list += @{
                            interfaceIndex = $d.InterfaceIndex
                            interfaceAlias = $d.InterfaceAlias
                            addresses = $d.ServerAddresses
                        }
                    }
                    $result = @{ success = $true; list = $list }
                } catch {
                    $result = @{ success = $false; error = $_.Exception.Message }
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            if (!data.success) {
                throw new Error(`Failed to retrieve DNS servers: ${data.error}`);
            }
            if (!data.list || data.list.length === 0) {
                return "No configured DNS servers detected.";
            }
            let text = "Configured DNS Servers:\n";
            data.list.forEach(dns => {
                const addrs = Array.isArray(dns.addresses) ? dns.addresses.join(', ') : dns.addresses;
                text += `- Interface "${dns.interfaceAlias}" (Index: ${dns.interfaceIndex}): DNS = [${addrs}]\n`;
            });
            return text.trim();
        }
        
        case "get_active_window": {
            const script = `
                try {
                    $code = @"
                    using System;
                    using System.Runtime.InteropServices;
                    using System.Text;
                    public class Win {
                        [DllImport("user32.dll")]
                        public static extern IntPtr GetForegroundWindow();
                        [DllImport("user32.dll")]
                        public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
                        [DllImport("user32.dll")]
                        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
                    }
"@
                    Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
                    $hwnd = [Win]::GetForegroundWindow()
                    $title = New-Object System.Text.StringBuilder 256
                    [Win]::GetWindowText($hwnd, $title, 256) | Out-Null
                    $procId = 0
                    [Win]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
                    $process = Get-Process -Id $procId -ErrorAction SilentlyContinue
                    $result = @{
                        success = $true
                        title = $title.ToString()
                        processName = if ($process) { $process.ProcessName } else { "Unknown" }
                        pid = $procId
                    }
                } catch {
                    $result = @{ success = $false; error = $_.Exception.Message }
                }
                $result | ConvertTo-Json -Compress
            `;
            const out = await runPowerShell(script);
            const data = JSON.parse(out);
            if (!data.success) {
                throw new Error(`Failed to retrieve active window: ${data.error}`);
            }
            if (!data.title && data.processName === "Unknown") {
                return "No active foreground window detected (desktop or system focus).";
            }
            return `Active Window Details:\n- Title: "${data.title || "No Title"}"\n- Process Name: "${data.processName}" (PID: ${data.pid})`;
        }
        
        default:
            throw new Error(`Tool not found: ${name}`);
    }
}

// Listen to stdin and process line-by-line
rl.on('line', async (line) => {
    line = line.trim();
    if (!line) return;
    
    let request;
    try {
        request = JSON.parse(line);
    } catch (e) {
        log(`Parse error: ${e.message}`);
        console.log(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32700, message: "Parse error" },
            id: null
        }));
        return;
    }
    
    const id = request.id !== undefined ? request.id : null;
    
    // Check for JSON-RPC properties
    if (request.jsonrpc !== "2.0" || !request.method) {
        log(`Invalid Request: missing jsonrpc or method`);
        console.log(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32600, message: "Invalid Request" },
            id
        }));
        return;
    }
    
    log(`Received request: ${request.method} (ID: ${id})`);
    
    try {
        switch (request.method) {
            case "initialize":
                console.log(JSON.stringify({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        protocolVersion: "2024-11-05",
                        capabilities: {
                            tools: {}
                        },
                        serverInfo: {
                            name: "system-media-control-server",
                            version: "1.0.0"
                        }
                    }
                }));
                break;
                
            case "notifications/initialized":
                // Standard notification, no response required
                log("Received initialization notification");
                break;
                
            case "tools/list":
                console.log(JSON.stringify({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        tools: toolsList
                    }
                }));
                break;
                
            case "tools/call": {
                const params = request.params || {};
                const name = params.name;
                const args = params.arguments || {};
                
                if (!name) {
                    console.log(JSON.stringify({
                        jsonrpc: "2.0",
                        id,
                        error: { code: -32602, message: "Invalid params: missing tool name" }
                    }));
                    break;
                }
                
                try {
                    const resultText = await callTool(name, args);
                    console.log(JSON.stringify({
                        jsonrpc: "2.0",
                        id,
                        result: {
                            content: [
                                {
                                    type: "text",
                                    text: resultText
                                }
                            ]
                        }
                    }));
                } catch (err) {
                    log(`Error running tool ${name}: ${err.message}`);
                    console.log(JSON.stringify({
                        jsonrpc: "2.0",
                        id,
                        error: { code: -32603, message: err.message }
                    }));
                }
                break;
            }
            
            default:
                log(`Method not found: ${request.method}`);
                console.log(JSON.stringify({
                    jsonrpc: "2.0",
                    id,
                    error: { code: -32601, message: "Method not found" }
                }));
        }
    } catch (err) {
        log(`Internal error handling request: ${err.message}`);
        console.log(JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message: err.message }
        }));
    }
});

log("MCP Server is running and waiting for JSON-RPC lines on stdin...");
