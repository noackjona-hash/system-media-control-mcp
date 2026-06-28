require('dotenv').config();
const { spawn } = require('child_process');
const readline = require('readline');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');

// Path to the MCP Server
const SERVER_PATH = './server.js';

// ANSI Console Colors
const COLORS = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m"
};

// Logging helpers (English defaults)
function logInfo(msg) {
    console.log(`${COLORS.green}${COLORS.bright}[Client]${COLORS.reset} ${msg}`);
}
function logStep(msg) {
    console.log(`${COLORS.yellow}${COLORS.bright}[Step]${COLORS.reset} ${msg}`);
}
function logTool(msg) {
    console.log(`${COLORS.cyan}${COLORS.bright}[Tool Call]${COLORS.reset} ${msg}`);
}
function logError(msg) {
    console.error(`${COLORS.red}${COLORS.bright}[Error]${COLORS.reset} ${msg}`);
}
function logServer(msg) {
    console.error(`${COLORS.magenta}[Server Log]${COLORS.reset} ${msg}`);
}

logInfo(`Starting MCP Server: node ${SERVER_PATH}...`);
const serverProcess = spawn('node', [SERVER_PATH]);

const serverRl = readline.createInterface({
    input: serverProcess.stdout,
    terminal: false
});

serverProcess.stderr.on('data', (data) => {
    logServer(data.toString().trim());
});

serverProcess.on('exit', (code) => {
    logInfo(`MCP Server process exited with code ${code}`);
    process.exit(code);
});

// JSON-RPC state
let nextRequestId = 1;
const pendingRequests = new Map();

serverRl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    
    try {
        const message = JSON.parse(line);
        if (message.id !== undefined && pendingRequests.has(message.id)) {
            const { resolve, reject } = pendingRequests.get(message.id);
            pendingRequests.delete(message.id);
            
            if (message.error) {
                reject(new Error(message.error.message || JSON.stringify(message.error)));
            } else {
                resolve(message.result);
            }
        }
    } catch (err) {
        logError(`Error parsing server message: ${err.message}. Raw: ${line}`);
    }
});

function sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = nextRequestId++;
        const request = {
            jsonrpc: "2.0",
            id,
            method,
            params
        };
        pendingRequests.set(id, { resolve, reject });
        serverProcess.stdin.write(JSON.stringify(request) + '\n');
    });
}

function sendNotification(method, params = {}) {
    const notification = {
        jsonrpc: "2.0",
        method,
        params
    };
    serverProcess.stdin.write(JSON.stringify(notification) + '\n');
}

async function callMcpTool(name, args) {
    const result = await sendRequest("tools/call", {
        name,
        arguments: args
    });
    if (result && result.content && result.content[0] && result.content[0].type === 'text') {
        return result.content[0].text;
    }
    return JSON.stringify(result);
}

async function runHandshake() {
    logStep("Sending 'initialize' request to MCP server...");
    const initResult = await sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
            name: "system-media-control-client",
            version: "1.0.0"
        }
    });
    logInfo(`Connection initialized. Server: ${initResult.serverInfo.name} (${initResult.serverInfo.version})`);

    logStep("Sending 'notifications/initialized' notification...");
    sendNotification("notifications/initialized");

    logStep("Requesting tool list...");
    const toolsResult = await sendRequest("tools/list");
    return toolsResult.tools || [];
}

async function runGemini(apiKey, query, mcpTools) {
    const genAI = new GoogleGenerativeAI(apiKey);
    const functionDeclarations = mcpTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
    }));

    const model = genAI.getGenerativeModel({
        model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
        tools: [{ functionDeclarations }]
    });

    const chat = model.startChat();
    logInfo(`Sending prompt to Gemini: "${query}"`);
    let result = await callWithRetry(() => chat.sendMessage(query), "Gemini");
    let response = result.response;
    
    let calls = response.functionCalls();
    while (calls && calls.length > 0) {
        const functionResponses = [];
        
        for (const call of calls) {
            logTool(`Gemini requested: ${COLORS.bright}${call.name}${COLORS.reset} with args: ${JSON.stringify(call.args)}`);
            try {
                const toolOutput = await callMcpTool(call.name, call.args);
                logInfo(`MCP Server responded: "${toolOutput.replace(/\n/g, ' ')}"`);
                
                functionResponses.push({
                    functionResponse: {
                        name: call.name,
                        response: { result: toolOutput }
                    }
                });
            } catch (err) {
                logError(`MCP execution failed: ${err.message}`);
                functionResponses.push({
                    functionResponse: {
                        name: call.name,
                        response: { error: err.message }
                    }
                });
            }
        }
        
        logStep(`Feeding tool results back to Gemini...`);
        result = await callWithRetry(() => chat.sendMessage(functionResponses), "Gemini");
        response = result.response;
        calls = response.functionCalls();
    }
    
    console.log(`\n${COLORS.green}${COLORS.bright}Gemini Final Response:${COLORS.reset}\n=================================\n${response.text()}\n=================================`);
}

// Retries a function if it encounters a rate limit (HTTP 429 / Rate Limit error)
async function callWithRetry(fn, providerName = "AI") {
    let delay = 2000; // start with 2 seconds delay
    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isRateLimit = 
                (err.status === 429) || 
                (err.statusCode === 429) ||
                (err.message && (
                    err.message.includes("429") || 
                    err.message.includes("rate_limit") || 
                    err.message.includes("Quota exceeded") || 
                    err.message.includes("too many requests") ||
                    err.message.includes("ResourceExhausted") ||
                    err.message.includes("limit")
                ));
                
            if (isRateLimit && attempt < maxRetries) {
                let waitMs = delay;
                if (err.headers && err.headers['retry-after']) {
                    const retryAfter = parseInt(err.headers['retry-after'], 10);
                    if (!isNaN(retryAfter)) {
                        waitMs = retryAfter * 1000;
                    }
                } else {
                    // Try parsing retryDelay from Google Gemini errors (e.g. retryDelay: "21s")
                    const matchSec = err.message.match(/retryDelay["']?\s*:\s*["']?(\d+)s/i) || err.message.match(/retry\s+after\s+(\d+)\s+seconds/i);
                    if (matchSec) {
                        waitMs = parseInt(matchSec[1], 10) * 1000;
                    }
                }
                
                logInfo(`[Rate Limit] ${providerName} returned 429 / Quota Exceeded. Waiting ${waitMs / 1000}s before retry (Attempt ${attempt}/${maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, waitMs + 500)); // add 500ms safety buffer
                delay *= 2; // double delay for next attempt
            } else {
                throw err;
            }
        }
    }
}

// Aggressively extracts and sanitizes the JSON block from raw text
function sanitizeJsonString(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) {
        return null;
    }
    let slice = text.substring(start, end + 1);
    
    // Clean up escaped quotes \" or \\"
    slice = slice.replace(/\\"/g, '"');
    
    return slice.trim();
}

// Lightweight tool pruning to prevent tiny local models from getting overwhelmed by 19 tools
function pruneToolsForLocalModel(query, mcpTools) {
    const lowerQuery = query.toLowerCase();
    
    // 1. Audio controls keywords
    if (lowerQuery.includes('lautstärke') || lowerQuery.includes('volume') || lowerQuery.includes('leiser') || lowerQuery.includes('lauter') || lowerQuery.includes('mute') || lowerQuery.includes('stumm')) {
        return mcpTools.filter(t => t.name === 'set_volume' || t.name === 'get_volume' || t.name === 'set_mute');
    }
    
    // 2. CPU / System status keywords
    if (lowerQuery.includes('auslastung') || lowerQuery.includes('busy') || lowerQuery.includes('cpu') || lowerQuery.includes('ram') || lowerQuery.includes('system') || lowerQuery.includes('pc') || lowerQuery.includes('status')) {
        return mcpTools.filter(t => t.name === 'get_system_status' || t.name === 'get_top_processes');
    }
    
    // 3. Media playback keywords
    if (lowerQuery.includes('musik') || lowerQuery.includes('play') || lowerQuery.includes('pause') || lowerQuery.includes('next') || lowerQuery.includes('skip') || lowerQuery.includes('prev') || lowerQuery.includes('weiter') || lowerQuery.includes('zurück')) {
        return mcpTools.filter(t => t.name === 'media_control');
    }
    
    // 4. Clipboard operations
    if (lowerQuery.includes('clipboard') || lowerQuery.includes('zwischenablage') || lowerQuery.includes('copy') || lowerQuery.includes('paste') || lowerQuery.includes('kopier') || lowerQuery.includes('clear') || lowerQuery.includes('leere')) {
        if (lowerQuery.includes('clear') || lowerQuery.includes('leeren') || lowerQuery.includes('leere') || lowerQuery.includes('lösch')) {
            return mcpTools.filter(t => t.name === 'clear_clipboard');
        }
        return mcpTools.filter(t => t.name === 'get_clipboard' || t.name === 'set_clipboard');
    }
    
    // 5. Open URL / Application launcher / Active window focus
    if (lowerQuery.includes('open') || lowerQuery.includes('launch') || lowerQuery.includes('öffne') || lowerQuery.includes('start') || lowerQuery.includes('active') || lowerQuery.includes('focus') || lowerQuery.includes('fokus') || lowerQuery.includes('fenster') || lowerQuery.includes('foreground')) {
        if (lowerQuery.includes('active') || lowerQuery.includes('focus') || lowerQuery.includes('fokus') || lowerQuery.includes('fenster') || lowerQuery.includes('foreground') || lowerQuery.includes('vordergrund')) {
            return mcpTools.filter(t => t.name === 'get_active_window');
        }
        return mcpTools.filter(t => t.name === 'open_url' || t.name === 'launch_app');
    }
    
    // 6. Network status & DNS
    if (lowerQuery.includes('network') || lowerQuery.includes('netzwerk') || lowerQuery.includes('ip') || lowerQuery.includes('dns') || lowerQuery.includes('name server')) {
        if (lowerQuery.includes('dns') || lowerQuery.includes('name server') || lowerQuery.includes('nameserver')) {
            return mcpTools.filter(t => t.name === 'get_dns_servers');
        }
        return mcpTools.filter(t => t.name === 'get_network_info');
    }
    
    // 7. Wi-Fi scanning & status
    if (lowerQuery.includes('wifi') || lowerQuery.includes('wlan') || lowerQuery.includes('ssid')) {
        if (lowerQuery.includes('status') || lowerQuery.includes('qualität') || lowerQuery.includes('speed') || lowerQuery.includes('verbindung')) {
            return mcpTools.filter(t => t.name === 'get_wifi_status');
        }
        return mcpTools.filter(t => t.name === 'get_wifi_networks');
    }
    
    // 8. Screenshot capture
    if (lowerQuery.includes('screenshot') || lowerQuery.includes('bildschirmfoto') || lowerQuery.includes('screen') || lowerQuery.includes('capture')) {
        return mcpTools.filter(t => t.name === 'take_screenshot');
    }
    
    // 9. Storage disk space metrics
    if (lowerQuery.includes('disk') || lowerQuery.includes('space') || lowerQuery.includes('festplatte') || lowerQuery.includes('speicher') || lowerQuery.includes('drive') || lowerQuery.includes('laufwerk')) {
        return mcpTools.filter(t => t.name === 'get_disk_space');
    }
    
    // 10. Recycle bin clearing
    if (lowerQuery.includes('recycle') || lowerQuery.includes('bin') || lowerQuery.includes('papierkorb') || lowerQuery.includes('leeren')) {
        return mcpTools.filter(t => t.name === 'empty_recycle_bin');
    }

    // 11. Hardware specifications
    if (lowerQuery.includes('hardware') || lowerQuery.includes('spezifikation') || lowerQuery.includes('modell') || lowerQuery.includes('mainboard') || lowerQuery.includes('bios') || lowerQuery.includes('specs') || lowerQuery.includes('motherboard')) {
        return mcpTools.filter(t => t.name === 'get_system_info');
    }

    // 12. Network latency / Pings
    if (lowerQuery.includes('ping') || lowerQuery.includes('latency') || lowerQuery.includes('latenz') || lowerQuery.includes('geschwindigkeit') || lowerQuery.includes('speedtest')) {
        return mcpTools.filter(t => t.name === 'get_network_latency');
    }

    // 13. UI Automation / Keystrokes
    if (lowerQuery.includes('key') || lowerQuery.includes('taste') || lowerQuery.includes('tippen') || lowerQuery.includes('type') || lowerQuery.includes('schreibe') || lowerQuery.includes('interact') || lowerQuery.includes('automation') || lowerQuery.includes('press')) {
        return mcpTools.filter(t => t.name === 'send_keystrokes');
    }
    
    // Fallback core tools list (max 3-4 tools)
    const fallbackTools = ['get_system_status', 'get_volume', 'get_top_processes', 'open_url'];
    return mcpTools.filter(t => fallbackTools.includes(t.name));
}

async function runOpenAI(apiKey, query, mcpTools, baseURL = undefined, modelName = "gpt-4o-mini") {
    const config = { apiKey };
    if (baseURL) {
        config.baseURL = baseURL;
    }
    const openai = new OpenAI(config);
    
    // Apply dynamic tool pruning for local AI models
    const finalTools = baseURL ? pruneToolsForLocalModel(query, mcpTools) : mcpTools;
    if (baseURL) {
        logInfo(`[Pruning] Reduced tool selection to ${finalTools.length} tools: ${finalTools.map(t => t.name).join(', ')}`);
    }

    const tools = finalTools.map(tool => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
        }
    }));

    const messages = [];
    const availableToolNames = finalTools.map(t => t.name).join(", ");
    let systemPrompt = "";
    if (baseURL) {
        // Prepend custom system prompt with one-shot example for local TinyLLMs
        systemPrompt = `Du bist ein Windows-PC-Systemassistent.
Verfügbare Tools: ${availableToolNames}
Wenn der Nutzer die Lautstärke ändern will, antworte AUSSCHLIESSLICH mit: {"name": "set_volume", "arguments": {"level": 50}}
Verwende dieses JSON-Muster für alle Aktionen. Antworte NUR im JSON-Format!`;
    } else {
        // Cloud agent prompt supporting chaining
        systemPrompt = `You are a helpful PC Windows agent assistant.
You can execute tools to interact with the system.
If the task requires multiple steps (e.g. checking status before modifying), call the tools sequentially in a chain.
Once you have retrieved all necessary information or successfully performed the action, summarize the outcome briefly and politely to the user. Do not ask follow-up questions.`;
    }
    messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: query });

    let running = true;
    let rePromptAttempts = 0;
    const maxAttempts = 2;
    let totalCalls = 0;
    const maxCallsLimit = 5;
    let lastExecutedTool = null;
    let cleanHistoryLength = messages.length;
    
    while (running) {
        if (rePromptAttempts === 0) {
            cleanHistoryLength = messages.length;
        }
        
        logStep(`Sending request to AI (${modelName})...`);
        const response = await callWithRetry(() => openai.chat.completions.create({
            model: modelName,
            messages,
            tools
        }), modelName);

        const choice = response.choices[0];
        const message = choice.message;
        
        // Push the assistant's message to the conversation history
        messages.push(message);

        // Stage 1: Validate native tool calls API block
        if (message.tool_calls && message.tool_calls.length > 0) {
            rePromptAttempts = 0; // reset attempts on successful execution path
            for (const toolCall of message.tool_calls) {
                const name = toolCall.function.name;
                const argsStr = toolCall.function.arguments;
                
                // Duplicate check
                if (lastExecutedTool && lastExecutedTool.name === name && lastExecutedTool.argsStr === argsStr) {
                    logError(`Loop protection: blocked duplicate tool call to ${name} with args ${argsStr}`);
                    console.log(`\n${COLORS.green}${COLORS.bright}AI Final Response (Loop Blocked):${COLORS.reset}\n=================================\nPC Agent: The AI model tried to repeat the same operation twice. Operation blocked to prevent loop.\n=================================`);
                    running = false;
                    break;
                }
                
                // Max calls check
                totalCalls++;
                if (totalCalls > maxCallsLimit) {
                    logError(`Loop protection: reached max tool calls limit of ${maxCallsLimit}`);
                    console.log(`\n${COLORS.green}${COLORS.bright}AI Final Response (Limit Reached):${COLORS.reset}\n=================================\nPC Agent: The AI model exceeded the execution limit of ${maxCallsLimit} steps. Execution stopped.\n=================================`);
                    running = false;
                    break;
                }
                
                lastExecutedTool = { name, argsStr };

                const args = JSON.parse(argsStr);
                
                logTool(`AI requested native: ${COLORS.bright}${name}${COLORS.reset} with args: ${argsStr}`);
                try {
                    const toolOutput = await callMcpTool(name, args);
                    logInfo(`MCP Server responded: "${toolOutput.replace(/\n/g, ' ')}"`);
                    
                    messages.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        name: name,
                        content: toolOutput
                    });
                } catch (err) {
                    logError(`MCP execution failed: ${err.message}`);
                    messages.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        name: name,
                        content: `Error: ${err.message}`
                    });
                }
            }
            if (baseURL) {
                // Inject strict final system reminder to avoid model confusion/irrelevant questions (local models only)
                messages.push({
                    role: "user",
                    content: "Die Tools wurden erfolgreich ausgeführt. Informiere den Nutzer kurz und sachlich, dass die Aktion erledigt ist. Stelle keine Gegenfragen!"
                });
            }
        } else {
            // Stage 2: Scan message.content for JSON-like blocks if native tool calls is empty
            const content = message.content || "";
            const hasJsonIndicator = content.includes('{') && (content.includes('"name":') || content.includes('"name" :'));
            
            // Check if it mentions any registered tool name to be extra precise
            const mentionsTool = mcpTools.some(tool => content.includes(tool.name));
            
            if (hasJsonIndicator || (content.includes('{') && mentionsTool)) {
                const jsonStr = sanitizeJsonString(content);
                let toolCallObj = null;
                let parseError = null;
                
                if (jsonStr) {
                    try {
                        toolCallObj = JSON.parse(jsonStr);
                        // Validate format
                        if (!toolCallObj.name) {
                            parseError = new Error("JSON tool call missing 'name' field.");
                        } else {
                            const isValidTool = mcpTools.some(t => t.name === toolCallObj.name);
                            if (!isValidTool) {
                                parseError = new Error(`Tool name '${toolCallObj.name}' is not registered on this server.`);
                            }
                        }
                    } catch (err) {
                        parseError = err;
                    }
                } else {
                    parseError = new Error("Sanitizer could not isolate a JSON block.");
                }
                
                if (toolCallObj && !parseError) {
                    // Valid tool call parsed manually from content text!
                    rePromptAttempts = 0; // reset
                    const name = toolCallObj.name;
                    const args = toolCallObj.arguments || toolCallObj.args || {};
                    const argsStr = JSON.stringify(args);
                    
                    // Duplicate check
                    if (lastExecutedTool && lastExecutedTool.name === name && lastExecutedTool.argsStr === argsStr) {
                        logError(`Loop protection: blocked duplicate tool call to ${name} with args ${argsStr}`);
                        console.log(`\n${COLORS.green}${COLORS.bright}AI Final Response (Loop Blocked):${COLORS.reset}\n=================================\nPC Agent: The AI model tried to repeat the same operation twice. Operation blocked to prevent loop.\n=================================`);
                        running = false;
                        break;
                    }
                    
                    // Max calls check
                    totalCalls++;
                    if (totalCalls > maxCallsLimit) {
                        logError(`Loop protection: reached max tool calls limit of ${maxCallsLimit}`);
                        console.log(`\n${COLORS.green}${COLORS.bright}AI Final Response (Limit Reached):${COLORS.reset}\n=================================\nPC Agent: The AI model exceeded the execution limit of ${maxCallsLimit} steps. Execution stopped.\n=================================`);
                        running = false;
                        break;
                    }
                    
                    lastExecutedTool = { name, argsStr };
                    
                    logTool(`AI requested text-JSON: ${COLORS.bright}${name}${COLORS.reset} with args: ${argsStr}`);
                    try {
                        const toolOutput = await callMcpTool(name, args);
                        logInfo(`MCP Server responded: "${toolOutput.replace(/\n/g, ' ')}"`);
                        
                        // Feed back to TinyLLM model
                        messages.push({
                            role: "user",
                            content: `System Response (Tool ${name} executed successfully): ${toolOutput}. Die Tools wurden erfolgreich ausgeführt. Informiere den Nutzer kurz und sachlich, dass die Aktion erledigt ist. Stelle keine Gegenfragen!`
                        });
                    } catch (err) {
                        logError(`MCP execution failed: ${err.message}`);
                        messages.push({
                            role: "user",
                            content: `System Response (Tool ${name} execution failed): ${err.message}`
                        });
                    }
                } else {
                    // Invalid/Malformed JSON or missing tool name validation
                    if (rePromptAttempts < maxAttempts) {
                        rePromptAttempts++;
                        logError(`JSON parsing/validation failed: ${parseError.message}`);
                        logStep(`${COLORS.yellow}${COLORS.bright}Malformed tool call from local model. Triggering self-correction prompt (Try ${rePromptAttempts}/${maxAttempts})...${COLORS.reset}`);
                        
                        // Rollback to clean state (removes failed assistant message and any previous attempts)
                        messages.length = cleanHistoryLength;
                        
                        // Push correction instructions containing original user query
                        messages.push({
                            role: "user",
                            content: `Du wolltest gerade die Aufgabe '${query}' erfüllen, aber dein JSON-Format war ungültig. Fehler-Details: ${parseError.message}. Antworte NUR mit dem korrekten JSON-Code! Output only valid JSON. Close all brackets and quotes. Format: {"name": "tool_name", "arguments": {...}}`
                        });
                    } else {
                        logError(`Exceeded maximum correction attempts (${maxAttempts}). Treating response as final text.`);
                        console.log(`\n${COLORS.green}${COLORS.bright}AI Final Response:${COLORS.reset}\n=================================\n${content}\n=================================`);
                        running = false;
                    }
                }
            } else {
                // Regular conversational response
                console.log(`\n${COLORS.green}${COLORS.bright}AI Final Response:${COLORS.reset}\n=================================\n${content}\n=================================`);
                running = false;
            }
        }
    }
}

async function runAnthropic(apiKey, query, mcpTools) {
    const messages = [{ role: "user", content: query }];
    const tools = mcpTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema
    }));

    let running = true;
    while (running) {
        logStep("Sending request to Anthropic (Claude)...");
        const response = await callWithRetry(async () => {
            const res = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json"
                },
                body: JSON.stringify({
                    model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022",
                    max_tokens: 1024,
                    tools,
                    messages
                })
            });
            if (!res.ok) {
                const errBody = await res.text();
                const err = new Error(`Anthropic API error: ${res.status} ${res.statusText} - ${errBody}`);
                err.status = res.status;
                err.headers = { 'retry-after': res.headers.get('retry-after') };
                throw err;
            }
            return res;
        }, "Anthropic");

        const data = await response.json();
        const assistantMessage = {
            role: "assistant",
            content: data.content
        };
        messages.push(assistantMessage);

        const toolCalls = data.content.filter(block => block.type === "tool_use");
        
        if (toolCalls.length > 0) {
            const toolResults = [];
            for (const call of toolCalls) {
                const name = call.name;
                const args = call.input;
                const id = call.id;
                
                logTool(`Claude requested: ${COLORS.bright}${name}${COLORS.reset} with args: ${JSON.stringify(args)}`);
                try {
                    const toolOutput = await callMcpTool(name, args);
                    logInfo(`MCP Server responded: "${toolOutput.replace(/\n/g, ' ')}"`);
                    
                    toolResults.push({
                        type: "tool_result",
                        tool_use_id: id,
                        content: toolOutput
                    });
                } catch (err) {
                    logError(`MCP execution failed: ${err.message}`);
                    toolResults.push({
                        type: "tool_result",
                        tool_use_id: id,
                        content: `Error: ${err.message}`,
                        is_error: true
                    });
                }
            }
            messages.push({
                role: "user",
                content: toolResults
            });
        } else {
            const textBlocks = data.content.filter(block => block.type === "text").map(block => block.text).join("\n");
            console.log(`\n${COLORS.green}${COLORS.bright}Claude Final Response:${COLORS.reset}\n=================================\n${textBlocks}\n=================================`);
            running = false;
        }
    }
}

async function runMockAI(query, mcpTools) {
    logInfo(`[Mock Mode] No API keys configured. Running locally.`);
    
    let toolName = null;
    let toolArgs = {};
    const lowerQuery = query.toLowerCase();
    
    if (lowerQuery.includes('volume') || lowerQuery.includes('sound') || lowerQuery.includes('loud')) {
        const match = lowerQuery.match(/(\d+)/);
        if (match) {
            toolName = 'set_volume';
            toolArgs = { level: Number(match[1]) };
        } else {
            toolName = 'get_volume';
        }
    } else if (lowerQuery.includes('mute')) {
        toolName = 'set_mute';
        toolArgs = { mute: !lowerQuery.includes('unmute') };
    } else if (lowerQuery.includes('paus') || lowerQuery.includes('play') || lowerQuery.includes('music') || lowerQuery.includes('stop')) {
        toolName = 'media_control';
        toolArgs = { action: lowerQuery.includes('next') ? 'next_track' : (lowerQuery.includes('prev') ? 'prev_track' : 'play_pause') };
    } else if (lowerQuery.includes('next') || lowerQuery.includes('skip')) {
        toolName = 'media_control';
        toolArgs = { action: 'next_track' };
    } else if (lowerQuery.includes('prev') || lowerQuery.includes('back')) {
        toolName = 'media_control';
        toolArgs = { action: 'prev_track' };
    } else if (lowerQuery.includes('process') || lowerQuery.includes('task') || lowerQuery.includes('cpu consuming') || lowerQuery.includes('busy')) {
        toolName = 'get_top_processes';
    } else if (lowerQuery.includes('battery') || lowerQuery.includes('power status') || lowerQuery.includes('charge')) {
        toolName = 'get_battery_status';
    } else if (lowerQuery.includes('brightness') || lowerQuery.includes('screen dim')) {
        const match = lowerQuery.match(/(\d+)/);
        if (match) {
            toolName = 'set_brightness';
            toolArgs = { level: Number(match[1]) };
        } else {
            toolName = 'get_brightness';
        }
    } else if (lowerQuery.includes('lock')) {
        toolName = 'system_power_control';
        toolArgs = { action: 'lock' };
    } else if (lowerQuery.includes('sleep') || lowerQuery.includes('suspend')) {
        toolName = 'system_power_control';
        toolArgs = { action: 'sleep' };
    } else if (lowerQuery.includes('shutdown')) {
        toolName = 'system_power_control';
        toolArgs = { action: 'shutdown' };
    } else if (lowerQuery.includes('restart') || lowerQuery.includes('reboot')) {
        toolName = 'system_power_control';
        toolArgs = { action: 'restart' };
    } else if (lowerQuery.includes('abort') || lowerQuery.includes('cancel shutdown')) {
        toolName = 'system_power_control';
        toolArgs = { action: 'abort_shutdown' };
    } else if (lowerQuery.includes('clipboard') || lowerQuery.includes('copy') || lowerQuery.includes('paste')) {
        if (lowerQuery.includes('copy') || lowerQuery.includes('write') || lowerQuery.includes('set')) {
            const match = query.match(/(?:copy|write|set|to)\s+['"](.+?)['"]/i) || query.match(/(?:copy|write|set)\s+(.+?)(?:\s+to|$)/i);
            toolName = 'set_clipboard';
            toolArgs = { text: match ? match[1].trim() : "Copied from PC Agent" };
        } else {
            toolName = 'get_clipboard';
        }
    } else if (lowerQuery.includes('open') || lowerQuery.includes('browser') || lowerQuery.includes('web')) {
        const match = query.match(/open\s+(https?:\/\/[^\s]+|[a-z0-9.-]+\.[a-z]{2,})/i);
        if (match) {
            toolName = 'open_url';
            toolArgs = { url: match[1] };
        } else {
            const appMatch = query.match(/open\s+([a-z0-9_-]+)/i) || query.match(/launch\s+([a-z0-9_-]+)/i);
            if (appMatch) {
                toolName = 'launch_app';
                toolArgs = { app: appMatch[1] };
            }
        }
    } else if (lowerQuery.includes('network') || lowerQuery.includes('ip') || lowerQuery.includes('wifi') || lowerQuery.includes('connection')) {
        toolName = 'get_network_info';
    } else if (lowerQuery.includes('desktop') || lowerQuery.includes('minimize all') || lowerQuery.includes('show desktop')) {
        toolName = 'show_desktop';
    } else if (lowerQuery.includes('gpu') || lowerQuery.includes('graphics') || lowerQuery.includes('grafikkarte')) {
        toolName = 'get_gpu_info';
    } else if (lowerQuery.includes('audio device') || lowerQuery.includes('sound device') || lowerQuery.includes('audiogeräte') || lowerQuery.includes('soundkarte')) {
        toolName = 'get_audio_devices';
    } else if (lowerQuery.includes('kill') || lowerQuery.includes('close process') || lowerQuery.includes('terminate') || lowerQuery.includes('prozess beenden')) {
        const match = query.match(/(?:kill|close process|terminate)\s+([a-z0-9._-]+)/i) || query.match(/(?:beenden)\s+([a-z0-9._-]+)/i);
        toolName = 'close_process';
        toolArgs = { target: match ? match[1].trim() : "" };
    } else if (lowerQuery.includes('status') || lowerQuery.includes('system') || lowerQuery.includes('pc') || lowerQuery.includes('usage')) {
        toolName = 'get_system_status';
    }
    
    if (toolName) {
        logTool(`Mock AI requested: ${COLORS.bright}${toolName}${COLORS.reset} with args: ${JSON.stringify(toolArgs)}`);
        try {
            const toolOutput = await callMcpTool(toolName, toolArgs);
            console.log(`\n${COLORS.green}${COLORS.bright}Mock AI Final Response:${COLORS.reset}\n=================================\n${toolOutput}\n=================================`);
        } catch (err) {
            logError(`Mock execution failed: ${err.message}`);
        }
    } else {
        console.log(`\n${COLORS.green}${COLORS.bright}Mock AI Final Response:${COLORS.reset}\n=================================\n[Mock AI] I understood: "${query}". No tools required.\n=================================`);
    }
}

async function main() {
    try {
        const mcpTools = await runHandshake();
        logInfo(`Discovered ${mcpTools.length} tools from server: ${mcpTools.map(t => t.name).join(', ')}`);
        
        // Provider routing
        let provider = (process.env.AI_PROVIDER || "").toLowerCase().trim();
        
        // Key definitions
        const keys = {
            gemini: process.env.GEMINI_API_KEY,
            openai: process.env.OPENAI_API_KEY,
            anthropic: process.env.ANTHROPIC_API_KEY,
            groq: process.env.GROQ_API_KEY,
            github: process.env.GITHUB_TOKEN,
            deepseek: process.env.DEEPSEEK_API_KEY,
            mistral: process.env.MISTRAL_API_KEY,
            cohere: process.env.COHERE_API_KEY,
            together: process.env.TOGETHER_API_KEY,
            openrouter: process.env.OPENROUTER_API_KEY,
            fireworks: process.env.FIREWORKS_API_KEY,
            togetherai: process.env.TOGETHER_API_KEY,
            cerebras: process.env.CEREBRAS_API_KEY,
            nebius: process.env.NEBIUS_API_KEY,
            deepinfra: process.env.DEEPINFRA_API_KEY,
            siliconflow: process.env.SILICONFLOW_API_KEY,
            sambanova: process.env.SAMBANNOVA_API_KEY || process.env.SAMBANNOVA_CLOUD_API_KEY,
            lepton: process.env.LEPTON_API_KEY,
            baseten: process.env.BASETEN_API_KEY,
            modal: process.env.MODAL_API_KEY,
            replicate: process.env.REPLICATE_API_KEY,
            anyscale: process.env.ANYSCALE_API_KEY,
            octoai: process.env.OCTOAI_API_KEY,
            novita: process.env.NOVITA_API_KEY,
            runpod: process.env.RUNPOD_API_KEY,
            lambda: process.env.LAMBDA_API_KEY,
            scaleway: process.env.SCALEWAY_API_KEY,
            cloudflare: process.env.CLOUDFLARE_API_KEY,
            watsonx: process.env.WATSONX_API_KEY,
            nvidia: process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY,
            upstage: process.env.UPSTAGE_API_KEY,
            reka: process.env.REKA_API_KEY,
            perplexity: process.env.PERPLEXITY_API_KEY,
            moonshot: process.env.MOONSHOT_API_KEY,
            abacus: process.env.ABACUS_API_KEY,
            predibase: process.env.PREDIBASE_API_KEY
        };
        
        // Auto-detect provider if none is specified in env
        if (!provider) {
            if (keys.gemini && keys.gemini !== 'your_gemini_api_key_here') provider = 'gemini';
            else if (keys.openai && keys.openai !== 'your_openai_api_key_here') provider = 'openai';
            else if (keys.anthropic && keys.anthropic !== 'your_anthropic_api_key_here') provider = 'anthropic';
            else if (keys.groq && keys.groq !== 'your_groq_api_key_here') provider = 'groq';
            else if (keys.github && keys.github !== 'your_github_token_here') provider = 'github';
            else if (keys.deepseek) provider = 'deepseek';
            else if (keys.mistral) provider = 'mistral';
            else if (keys.openrouter) provider = 'openrouter';
            else if (keys.together) provider = 'together';
            else if (keys.perplexity) provider = 'perplexity';
            else if (process.env.LOCAL_API_BASE) provider = 'local';
            else provider = 'mock';
        }
        
        logInfo(`Active AI Provider: ${COLORS.bright}${provider.toUpperCase()}${COLORS.reset}`);
        
        async function runRequest(q) {
            try {
                if (provider === 'gemini') {
                    await runGemini(keys.gemini, q, mcpTools);
                } else if (provider === 'anthropic') {
                    await runAnthropic(keys.anthropic, q, mcpTools);
                } else if (provider === 'mock') {
                    await runMockAI(q, mcpTools);
                } else {
                    // Generic OpenAI-Compatible routing mapping for all requested providers
                    let apiBase = undefined;
                    let apiKey = keys[provider] || process.env.OPENAI_API_KEY || "local-key";
                    let modelName = process.env.AI_MODEL;
                    
                    switch (provider) {
                        case 'openai':
                            modelName = modelName || process.env.OPENAI_MODEL || "gpt-4o-mini";
                            break;
                        case 'groq':
                            apiBase = "https://api.groq.com/openai/v1";
                            modelName = modelName || process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
                            break;
                        case 'github':
                            apiBase = "https://models.inference.ai.azure.com";
                            apiKey = keys.github;
                            modelName = modelName || process.env.GITHUB_MODEL || "gpt-4o";
                            break;
                        case 'deepseek':
                            apiBase = "https://api.deepseek.com";
                            modelName = modelName || "deepseek-chat";
                            break;
                        case 'mistral':
                            apiBase = "https://api.mistral.ai/v1";
                            modelName = modelName || "mistral-large-latest";
                            break;
                        case 'perplexity':
                            apiBase = "https://api.perplexity.ai";
                            modelName = modelName || "sonar-reasoning";
                            break;
                        case 'together':
                        case 'togetherai':
                            apiBase = "https://api.together.xyz/v1";
                            modelName = modelName || "meta-llama/Llama-3.3-70B-Instruct-Turbo";
                            break;
                        case 'openrouter':
                            apiBase = "https://openrouter.ai/api/v1";
                            modelName = modelName || "google/gemini-2.5-flash";
                            break;
                        case 'fireworks':
                        case 'fireworksai':
                            apiBase = "https://api.fireworks.ai/inference/v1";
                            modelName = modelName || "accounts/fireworks/models/llama-v3p3-70b-instruct";
                            break;
                        case 'nebius':
                        case 'nebiusai':
                            apiBase = "https://api.studio.nebius.ai/v1";
                            modelName = modelName || "meta-llama/Meta-Llama-3.1-70B-Instruct";
                            break;
                        case 'deepinfra':
                            apiBase = "https://api.deepinfra.com/v1/openai";
                            modelName = modelName || "meta-llama/Llama-3.3-70B-Instruct";
                            break;
                        case 'siliconflow':
                            apiBase = "https://api.siliconflow.cn/v1";
                            modelName = modelName || "deepseek-ai/DeepSeek-V3";
                            break;
                        case 'sambanova':
                        case 'sambanovaai':
                            apiBase = "https://api.sambanova.ai/v1";
                            modelName = modelName || "Meta-Llama-3.1-70B-Instruct";
                            break;
                        case 'lepton':
                            apiBase = "https://api.lepton.ai/v1";
                            modelName = modelName || "llama3-1-70b";
                            break;
                        case 'baseten':
                            apiBase = "https://bridge.baseten.co/v1";
                            modelName = modelName || "meta-llama-3-1-70b-instruct";
                            break;
                        case 'modal':
                            apiBase = process.env.MODAL_API_BASE;
                            modelName = modelName || "llama-3-1-70b-instruct";
                            break;
                        case 'anyscale':
                            apiBase = "https://api.endpoints.anyscale.com/v1";
                            modelName = modelName || "meta-llama/Meta-Llama-3-70B-Instruct";
                            break;
                        case 'octoai':
                            apiBase = "https://text.octoai.run/v1";
                            modelName = modelName || "meta-llama-3-70b-instruct";
                            break;
                        case 'runpod':
                            apiBase = `https://api.runpod.ai/v2/${process.env.RUNPOD_POD_ID}/openai/v1`;
                            modelName = modelName || "llama-3-70b-instruct";
                            break;
                        case 'lambda':
                            apiBase = "https://api.lambdalabs.com/v1";
                            modelName = modelName || "llama3-70b-instruct";
                            break;
                        case 'scaleway':
                            apiBase = "https://api.scaleway.ai/v1";
                            modelName = modelName || "llama-3-1-70b-instruct";
                            break;
                        case 'cloudflare':
                            const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
                            apiBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
                            modelName = modelName || "@cf/meta/llama-3.1-70b-instruct";
                            break;
                        case 'watsonx':
                            apiBase = "https://us-south.ml.cloud.ibm.com/ml/v1/text/generation?version=2023-05-29";
                            modelName = modelName || "ibm/granite-13b-chat-v2";
                            break;
                        case 'nvidia':
                        case 'nvidianim':
                            apiBase = "https://integrate.api.nvidia.com/v1";
                            modelName = modelName || "meta/llama3-70b-instruct";
                            break;
                        case 'upstage':
                            apiBase = "https://api.upstage.ai/v1/solar";
                            modelName = modelName || "solar-1-mini-chat";
                            break;
                        case 'moonshot':
                        case 'moonshotai':
                            apiBase = "https://api.moonshot.cn/v1";
                            modelName = modelName || "moonshot-v1-8k";
                            break;
                        case 'local':
                            apiBase = process.env.LOCAL_API_BASE || "http://localhost:11434/v1";
                            modelName = modelName || process.env.LOCAL_MODEL || "llama3.2:1b";
                            break;
                        default:
                            // Fallback custom providers configuration (e.g. LiteLLM, Vercel AI Gateway, Portkey, Azure, AWS Bedrock, Google Vertex, Ernie, Hunyuan, Volcano)
                            apiBase = process.env.CUSTOM_API_BASE || "http://localhost:11434/v1";
                            modelName = modelName || process.env.CUSTOM_MODEL || "llama3";
                            break;
                    }
                    
                    await runOpenAI(apiKey, q, mcpTools, apiBase, modelName);
                }
            } catch (err) {
                logError(`Failed to process AI execution: ${err.message}`);
            }
        }

        let query = process.argv.slice(2).join(' ').trim();
        
        if (query) {
            // CLI Single-Shot Mode
            await runRequest(query);
        } else {
            // Continuous Interactive English Console Loop
            console.log(`\n${COLORS.yellow}${COLORS.bright}--- PC Windows Agent (Interactive Mode) ---${COLORS.reset}`);
            console.log(`Ask questions or issue commands in natural language.`);
            console.log(`Supported actions: volume/brightness control, media player buttons, clipboard copy/paste, URL/app launcher, power commands.`);
            console.log(`Type ${COLORS.bright}'exit'${COLORS.reset} or ${COLORS.bright}'q'${COLORS.reset} to shut down.\n`);
            
            const userRl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            
            while (true) {
                const answer = await new Promise((resolve) => {
                    userRl.question(`${COLORS.bright}${COLORS.white}Ask PC Agent > ${COLORS.reset}`, resolve);
                });
                const trimmed = answer.trim();
                
                if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'q' || trimmed.toLowerCase() === 'quit') {
                    break;
                }
                if (!trimmed) continue;
                
                await runRequest(trimmed);
                console.log(); // empty spacing line
            }
            userRl.close();
        }
    } catch (err) {
        logError(`Fatal Error in client execution: ${err.message}`);
    } finally {
        logInfo("Shutting down MCP Server background process...");
        serverProcess.kill();
        process.exit(0);
    }
}

main();
