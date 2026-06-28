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
                    int SetMute(bool bMute, Guid pguidEventContext);
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
                    int SetMute(bool bMute, Guid pguidEventContext);
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
                    int SetMute(bool bMute, Guid pguidEventContext);
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
