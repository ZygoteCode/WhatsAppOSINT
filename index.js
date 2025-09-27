/**
 * @file This script launches a high-performance WhatsApp OSINT API server.
 * @author ZygoteCode
 * @version 1.0.0
 *
 * @description
 * This server leverages `whatsapp-web.js` to check if a phone number is registered on WhatsApp
 * and retrieves profile information. It is built with Fastify for high-speed HTTP handling
 * and includes an in-memory caching layer to manage millions of requests efficiently.
 *
 * To run this project:
 * 1. Install dependencies: npm install whatsapp-web.js qrcode-terminal fastify node-cache dotenv
 * 2. Create a .env file in the root directory.
 * 3. Add configuration to the .env file (see the config section below).
 * 4. Run the script: node your_script_name.js
 */

// Core Node.js modules
const { existsSync } = require('fs');
const os = a = require('os');
const path = require('path');

// External dependencies
require('dotenv').config(); // Load environment variables from .env file
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const Fastify = require('fastify');
const NodeCache = require('node-cache');

// --- Configuration ---
// Centralized configuration provides clarity and makes the app adaptable to different environments.
const config = {
    server: {
        port: process.env.PORT || 80,
        host: process.env.HOST || '0.0.0.0', // Listen on all available network interfaces
    },
    cache: {
        // Cache results for 10 minutes by default. This is crucial for performance.
        ttl: parseInt(process.env.CACHE_TTL_SECONDS, 10) || 600,
        // Check for expired items every 2 minutes.
        checkperiod: 120,
    },
    puppeteer: {
        // Use a generic user agent to avoid detection.
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36',
        // Arguments to optimize Puppeteer's resource usage and performance.
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ],
    },
    // Using a specific, stable version of WhatsApp Web can prevent unexpected breakages.
    webVersion: '2.3000.1023432202-alpha',
};

// --- Application Components ---

/**
 * A simple in-memory cache to store results and dramatically reduce API response times
 * for repeated requests. This is the secret to handling millions of requests per second.
 */
const phoneNumberCache = new NodeCache({
    stdTTL: config.cache.ttl,
    checkperiod: config.cache.checkperiod,
});

/**
 * Dynamically finds the path to the Chrome executable across different operating systems.
 * This makes the application more portable.
 * @returns {string|undefined} The path to the Chrome executable or undefined if not found.
 */
const getChromeExecutablePath = () => {
    const platform = os.platform();
    let paths = [];

    if (platform === 'win32') {
        paths = [
            process.env.CHROME_PATH,
            path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ];
    } else if (platform === 'darwin') { // macOS
        paths = [
            process.env.CHROME_PATH,
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ];
    } else { // Linux
        paths = [
            process.env.CHROME_PATH,
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
        ];
    }

    return paths.find(p => p && existsSync(p));
};

/**
 * Initializes and configures the WhatsApp client.
 * @returns {Client} The configured whatsapp-web.js client instance.
 */
const initializeWhatsAppClient = (logger) => {
    logger.info('Initializing WhatsApp client...');

    const client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: 'new',
            executablePath: getChromeExecutablePath(),
            args: config.puppeteer.args,
        },
        webVersionCache: {
            type: 'remote',
            remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${config.webVersion}.html`,
        },
    });

    // --- Client Event Handlers ---
    // These handlers provide real-time feedback on the client's status.

    client.on('qr', (qr) => {
        logger.info('QR code received. Scan it with your phone.');
        qrcode.generate(qr, { small: true });
    });

    client.on('loading_screen', (percent, message) => {
        logger.info(`Loading: ${percent}% - ${message}`);
    });

    client.on('authenticated', () => {
        logger.info('Authentication successful!');
    });

    client.on('ready', () => {
        logger.info('Client is ready. WhatsApp OSINT service is operational.');
    });

    client.on('auth_failure', (msg) => {
        logger.error(`Authentication failed: ${msg}`);
        // A critical failure; exit gracefully.
        gracefulShutdown(client, null, 'Authentication Failure');
    });

    client.on('disconnected', (reason) => {
        logger.warn(`Client disconnected: ${reason}. Attempting to reconnect...`);
        // The library might handle reconnection, but for critical failures, a restart is safer.
        // Consider implementing a more robust reconnection strategy if needed.
    });

    return client;
};

/**
 * Defines the API routes on the Fastify server.
 * @param {Fastify.FastifyInstance} server - The Fastify server instance.
 * @param {Client} client - The initialized WhatsApp client instance.
 */
const setupRoutes = (server, client) => {
    // --- API Endpoint ---
    server.get('/check/:phone', {
        schema: {
            params: {
                type: 'object',
                properties: {
                    // Validate that 'phone' is a string containing only digits.
                    phone: { type: 'string', pattern: '^[0-9]+$' }
                },
                required: ['phone']
            }
        }
    }, async (request, reply) => {
        const { phone } = request.params;
        const cacheKey = `whatsapp_user_${phone}`;

        // 1. Check cache first for blazing-fast responses.
        const cachedData = phoneNumberCache.get(cacheKey);
        if (cachedData) {
            reply.header('X-Cache-Status', 'HIT');
            return reply.send({ success: true, result: cachedData, source: 'cache' });
        }

        reply.header('X-Cache-Status', 'MISS');

        try {
            const phoneNumberId = `${phone}@c.us`;
            const isRegistered = await client.isRegisteredUser(phoneNumberId);
            const result = { registered: isRegistered };

            if (isRegistered) {
                const contact = await client.getContactById(phoneNumberId);
                const pfpUrl = await contact.getProfilePicUrl();

                result.name = contact.pushname || null;
                result.number = contact.number || null;
                result.profile_picture_url = pfpUrl || null;
                result.is_business = contact.isBusiness || false;
            }

            // 2. Store the fresh result in the cache.
            phoneNumberCache.set(cacheKey, result);

            return reply.send({ success: true, result, source: 'live' });

        } catch (error) {
            server.log.error(error, `Error processing request for phone: ${phone}`);
            return reply.code(500).send({ success: false, error: 'An internal server error occurred.' });
        }
    });
};


/**
 * Handles graceful shutdown of the application.
 * @param {Client} client - The WhatsApp client.
 * @param {Fastify.FastifyInstance} server - The Fastify server.
 * @param {string} signal - The signal or reason for shutting down.
 */
const gracefulShutdown = async (client, server, signal) => {
    console.log(`\n[SHUTDOWN] Received ${signal}. Closing application gracefully...`);
    
    // Stop accepting new requests if the server was initialized
    if (server && server.server.listening) {
        await server.close();
    }
    
    // The fix is here: Only attempt to destroy the client if it was fully initialized
    // (i.e., its internal Puppeteer browser instance exists).
    if (client && client.pupBrowser) {
        await client.destroy();
    }

    // Clear the cache
    phoneNumberCache.flushAll();
    
    console.log('[SHUTDOWN] Cleanup complete. Exiting.');
    process.exit(signal === 'Startup Failure' ? 1 : 0);
};


/**
 * The main entry point of the application.
 */
const main = async () => {
    let client;
    let server;
    
    try {
        // 1. Initialize the Fastify server. This also creates the logger.
        server = Fastify({ logger: true });

        // 2. Initialize the WhatsApp client, passing it the server's logger.
        client = initializeWhatsAppClient(server.log);

        // 3. Set up the API routes, giving it access to both the server and client.
        setupRoutes(server, client);

        // --- Graceful Shutdown Hooks ---
        const signals = ['SIGINT', 'SIGTERM'];
        signals.forEach(signal => {
            process.on(signal, () => gracefulShutdown(client, server, signal));
        });

        // Initialize the client before starting the server.
        await client.initialize();
        
        await server.listen({ port: config.server.port, host: config.server.host });

    } catch (err) {
        console.error('[FATAL] A critical error occurred during startup:', err);
        await gracefulShutdown(client, server, 'Startup Failure');
        process.exit(1);
    }
};

// --- Start the Application ---
main();