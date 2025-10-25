const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb"); // Import MongoDB client

// --- START: MongoDB Setup ---
// IMPORTANT: Use Environment Variable in Production (See Step 4 later)
// For now, paste your connection string here during testing, BUT REMEMBER TO CHANGE IT
const mongoUri = process.env.MONGODB_URI || "mongodb+srv://syrjaServerUser:YOUR_SAVED_PASSWORD@yourclustername.mongodb.net/?retryWrites=true&w=majority"; // Replace placeholder or use env var

if (!mongoUri) {
    console.error("🚨 FATAL ERROR: MONGODB_URI environment variable is not set and no fallback provided.");
    process.exit(1);
}

// Create a MongoClient with options
const mongoClient = new MongoClient(mongoUri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

let db; // To hold the database connection
let idsCollection; // To hold the collection reference

async function connectToMongo() {
  try {
    await mongoClient.connect();
    db = mongoClient.db("syrjaAppDb"); // Choose a database name
    idsCollection = db.collection("syrjaIds"); // Choose a collection name

    // --- TTL Index for Temporary IDs ---
    await idsCollection.createIndex({ "expireAt": 1 }, { expireAfterSeconds: 0 });

    console.log("✅ Connected successfully to MongoDB Atlas");
  } catch (err) {
    console.error("❌ Failed to connect to MongoDB Atlas", err);
    process.exit(1); // Exit if DB connection fails on startup
  }
}
// --- END: MongoDB Setup ---


// Simple word lists for more memorable IDs
const ADJECTIVES = ["alpha", "beta", "gamma", "delta", "zeta", "nova", "comet", "solar", "lunar", "star"];
const NOUNS = ["fox", "wolf", "hawk", "lion", "tiger", "bear", "crane", "iris", "rose", "maple"];

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});
// --- START: Syrja ID Directory Service (v2) ---

app.use(express.json()); // Middleware to parse JSON bodies
app.use(cors());       // CORS Middleware

// Initialize node-persist storage


// Endpoint to claim a new Syrja ID
// Endpoint to claim a new Syrja ID (MODIFIED for MongoDB)
app.post("/claim-id", async (req, res) => {
    const { customId, fullInviteCode, persistence, privacy, pubKey } = req.body; // Added privacy

    // Added privacy check in condition
    if (!customId || !fullInviteCode || !persistence || !privacy || !pubKey) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    try {
        // Check if this public key already owns a DIFFERENT ID using MongoDB findOne
        const existingUserEntry = await idsCollection.findOne({ pubKey: pubKey });
        // Use _id from MongoDB document
        if (existingUserEntry && existingUserEntry._id !== customId) {
            return res.status(409).json({ error: "You already own a different ID. Please delete it before claiming a new one." });
        }

        // Check if the requested ID is taken by someone else using MongoDB findOne
        const existingIdEntry = await idsCollection.findOne({ _id: customId });
        if (existingIdEntry && existingIdEntry.pubKey !== pubKey) {
            return res.status(409).json({ error: "ID already taken" });
        }

        // Prepare the document to insert/update for MongoDB
        const syrjaDoc = {
            _id: customId, // Use the customId as the MongoDB document ID
            code: fullInviteCode,
            pubKey: pubKey,
            permanent: persistence === 'permanent',
            privacy: privacy, // Store privacy setting
            updatedAt: new Date() // Track last update time
        };

        // Set expiration only for temporary IDs for MongoDB TTL index
        if (persistence === 'temporary') {
            syrjaDoc.expireAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
        } else {
            syrjaDoc.expireAt = null; // Explicitly set to null for permanent
        }

        // Use replaceOne with upsert:true to insert or replace the document
        await idsCollection.replaceOne(
            { _id: customId }, // Filter by ID
            syrjaDoc,        // The document data
            { upsert: true }   // Insert if it doesn't exist
        );

        // If making permanent, ensure expireAt field is removed using $unset
        if (persistence === 'permanent') {
             await idsCollection.updateOne({ _id: customId }, { $unset: { expireAt: "" } });
        }

        // Updated console log
        console.log(`✅ ID Claimed/Updated: ${customId} (Permanent: ${syrjaDoc.permanent}, Privacy: ${privacy})`);
        res.json({ success: true, id: customId });

    } catch (err) {
        console.error("claim-id error:", err);
        res.status(500).json({ error: "Database operation failed" });
    }
});
// Endpoint to get an invite code from a Syrja ID (for adding contacts)
// Endpoint to get an invite code from a Syrja ID (MODIFIED for MongoDB)
app.get("/get-invite/:id", async (req, res) => {
    const fullId = `syrja/${req.params.id}`;
    try {
        // Use findOne to get the document by its _id
        const item = await idsCollection.findOne({ _id: fullId });

        // Check if the item exists and has a code
        if (item && item.code) {
            // --- NEW: Check privacy setting ---
            if (item.privacy === 'private') {
                 console.log(`🔒 Attempt to resolve private Syrja ID denied: ${fullId}`);
                 // Return 403 Forbidden status for private IDs
                 return res.status(403).json({ error: "This ID is private" });
            }
            // --- END NEW ---

            // If public or privacy not set (default public), return the code
            console.log(`➡️ Resolved Syrja ID: ${fullId} (Privacy: ${item.privacy || 'public'})`);
            res.json({ fullInviteCode: item.code });
        } else {
            // Item not found or doesn't have a code field
            console.log(`❓ Failed to resolve Syrja ID: ${fullId}`);
            res.status(404).json({ error: "ID not found or has expired" });
        }
    } catch (err) {
        // Handle potential database errors
        console.error("get-invite error:", err);
        res.status(500).json({ error: "Database operation failed" });
    }
});

// Endpoint to find a user's current ID by their public key
// Endpoint to find a user's current ID by their public key (MODIFIED for MongoDB)
app.get("/get-id-by-pubkey/:pubkey", async (req, res) => {
    const pubkey = req.params.pubkey;
    try {
        // Use findOne to search by the pubKey field
        const item = await idsCollection.findOne({ pubKey: pubkey });

        if (item) {
            // Found a match, return the document's _id and other details
            console.log(`🔎 Found ID for pubkey ${pubkey.slice(0,12)}... -> ${item._id}`);
            // Include privacy in the response
            res.json({ id: item._id, permanent: item.permanent, privacy: item.privacy });
        } else {
            // No document found matching the public key
            console.log(`🔎 No ID found for pubkey ${pubkey.slice(0,12)}...`);
            res.status(404).json({ error: "No ID found for this public key" });
        }
    } catch (err) {
        // Handle potential database errors
        console.error("get-id-by-pubkey error:", err);
        res.status(500).json({ error: "Database operation failed" });
    }
});
// Endpoint to delete an ID, authenticated by public key
// Endpoint to delete an ID, authenticated by public key (MODIFIED for MongoDB)
app.post("/delete-id", async (req, res) => {
    const { pubKey } = req.body;
    if (!pubKey) return res.status(400).json({ error: "Public key is required" });

    try {
        // Use deleteOne to remove the document matching the public key
        const result = await idsCollection.deleteOne({ pubKey: pubKey });

        // Check if a document was actually deleted
        if (result.deletedCount > 0) {
            console.log(`🗑️ Deleted Syrja ID for pubKey: ${pubKey.slice(0,12)}...`);
            res.json({ success: true });
        } else {
            // If deletedCount is 0, no document matched the pubKey
            console.log(`🗑️ No Syrja ID found for pubKey ${pubKey.slice(0,12)}... to delete.`);
            res.json({ success: true, message: "No ID found to delete" });
        }
    } catch (err) {
        // Handle potential database errors
        console.error("delete-id error:", err);
        res.status(500).json({ error: "Database operation failed" });
    }
});



// --- END: Syrja ID Directory Service (v2) ---
// --- START: Simple Rate Limiting ---
const rateLimit = new Map();
const LIMIT = 20; // Max 20 requests
const TIME_FRAME = 60 * 1000; // per 60 seconds (1 minute)

function isRateLimited(socket) {
  const ip = socket.handshake.address;
  const now = Date.now();
  const record = rateLimit.get(ip);

  if (!record) {
    rateLimit.set(ip, { count: 1, startTime: now });
    return false;
  }

  // If time window has passed, reset
  if (now - record.startTime > TIME_FRAME) {
    rateLimit.set(ip, { count: 1, startTime: now });
    return false;
  }

  // If count exceeds limit, block the request
  if (record.count >= LIMIT) {
    return true;
  }

  // Otherwise, increment count and allow
  record.count++;
  return false;
}
// --- END: Simple Rate Limiting ---

// just to confirm server is alive
app.get("/", (req, res) => {
  res.send("✅ Signaling server is running");
});

// Map a user's permanent pubKey to their temporary socket.id
const userSockets = {};

// Map a pubKey to the list of sockets that are subscribed to it
// { "contact_PubKey": ["subscriber_socket_id_1", "subscriber_socket_id_2"] }
const presenceSubscriptions = {};

// Map a socket.id to the list of pubKeys it is subscribed to (for easy cleanup)
// { "subscriber_socket_id_1": ["contact_PubKey_A", "contact_PubKey_B"] }
const socketSubscriptions = {};

// Helper to normalize keys
function normKey(k){ return (typeof k === 'string') ? k.replace(/\s+/g,'') : k; }

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Handle client registration
  socket.on("register", (pubKey) => {
    if (isRateLimited(socket)) {
      console.log(`⚠️ Rate limit exceeded for registration by ${socket.handshake.address}`);
      return;
    }
    if (!pubKey) return;
    const key = normKey(pubKey);
    userSockets[key] = socket.id;
    socket.data.pubKey = key; // Store key on socket for later cleanup
    console.log(`🔑 Registered: ${key.slice(0,12)}... -> ${socket.id}`);

    socket.emit('registered', { status: 'ok' });
    
  // --- Notify subscribers that this user is now online ---
    const subscribers = presenceSubscriptions[key];
    if (subscribers && subscribers.length) {
      console.log(`📢 Notifying ${subscribers.length} subscribers that ${key.slice(0,12)}... is online.`);
      subscribers.forEach(subscriberSocketId => {
        io.to(subscriberSocketId).emit("presence-update", { pubKey: key, status: "online" });
      });
    }
  });
  
  
  
  // Handle presence subscription
  socket.on("subscribe-to-presence", (contactPubKeys) => {
    console.log(`📡 Presence subscription from ${socket.id} for ${contactPubKeys.length} contacts.`);

    // --- 1. Clean up any previous subscriptions for this socket ---
    const oldSubscriptions = socketSubscriptions[socket.id];
    if (oldSubscriptions && oldSubscriptions.length) {
      oldSubscriptions.forEach(pubKey => {
        if (presenceSubscriptions[pubKey]) {
          presenceSubscriptions[pubKey] = presenceSubscriptions[pubKey].filter(id => id !== socket.id);
          if (presenceSubscriptions[pubKey].length === 0) {
            delete presenceSubscriptions[pubKey];
          }
        }
      });
    }

    // --- 2. Create the new subscriptions ---
    socketSubscriptions[socket.id] = contactPubKeys;
    contactPubKeys.forEach(pubKey => {
      const key = normKey(pubKey);
      if (!presenceSubscriptions[key]) {
        presenceSubscriptions[key] = [];
      }
      presenceSubscriptions[key].push(socket.id);
    });

    // --- 3. Reply with the initial online status of the subscribed contacts ---
    const initialOnlineContacts = contactPubKeys.filter(key => !!userSockets[normKey(key)]);
    socket.emit("presence-initial-status", initialOnlineContacts);
  });

  // Handle direct connection requests
  socket.on("request-connection", async ({ to, from }) => {
    if (isRateLimited(socket)) {
      console.log(`⚠️ Rate limit exceeded for request-connection by ${socket.handshake.address}`);
      return;
    }

    const toKey = normKey(to);
    const fromKey = normKey(from);
    const targetSocketId = userSockets[toKey];

    if (targetSocketId) {
      // --- This is the existing logic for ONLINE users ---
      io.to(targetSocketId).emit("incoming-request", { from: fromKey });
      console.log(`📨 Connection request (online): ${fromKey.slice(0, 12)}... → ${toKey.slice(0, 12)}...`);
    } else {
      // --- NEW LOGIC for OFFLINE users with Sleep Mode ---
      console.log(`⚠️ User ${toKey.slice(0, 12)} is offline. Checking for push subscription...`);
      const subscription = await storage.getItem(`sub_${toKey}`);
      
      if (subscription) {
        try {
          const payload = JSON.stringify({
            title: "Syrja: New Connection Request",
            body: `A contact wants to chat with you.` // Body is kept generic for privacy
          });

          await webpush.sendNotification(subscription, payload);
          console.log(`🚀 Push notification sent to sleeping user: ${toKey.slice(0, 12)}...`);
        } catch (err) {
          console.error(`❌ Failed to send push notification to ${toKey.slice(0, 12)}...`, err.body || err);
          // If subscription is invalid (e.g., user cleared data), remove it.
          if (err.statusCode === 404 || err.statusCode === 410) {
            console.log(`🗑️ Removing expired push subscription for ${toKey.slice(0, 12)}...`);
            await storage.removeItem(`sub_${toKey}`);
          }
        }
      } else {
      // User is offline. The web-push logic has been removed for the Electron app.
        console.log(`- User ${toKey.slice(0, 12)}... is offline. No notification sent.`);
      }
    }
  });

  // Handle connection acceptance
  socket.on("accept-connection", ({ to, from }) => {
    const targetId = userSockets[normKey(to)];
    if (targetId) {
      io.to(targetId).emit("connection-accepted", { from: normKey(from) });
      console.log(`✅ Connection accepted: ${from.slice(0, 12)}... → ${to.slice(0, 12)}...`);
    } else {
      console.log(`⚠️ Could not deliver acceptance to ${to.slice(0,12)} (not registered/online)`);
    }
  });

  // server.js - New Code
// -- Video/Voice Call Signaling --
socket.on("call-request", ({ to, from, callType }) => {
    const targetId = userSockets[normKey(to)];
    if (targetId) {
        io.to(targetId).emit("incoming-call", { from: normKey(from), callType });
        console.log(`📞 Call request (${callType}): ${from.slice(0,12)}... → ${to.slice(0,12)}...`);
    }
});

socket.on("call-accepted", ({ to, from }) => {
    const targetId = userSockets[normKey(to)];
    if (targetId) {
        io.to(targetId).emit("call-accepted", { from: normKey(from) });
        console.log(`✔️ Call accepted: ${from.slice(0,12)}... → ${to.slice(0,12)}...`);
    }
});

socket.on("call-rejected", ({ to, from }) => {
    const targetId = userSockets[normKey(to)];
    if (targetId) {
        io.to(targetId).emit("call-rejected", { from: normKey(from) });
        console.log(`❌ Call rejected: ${from.slice(0,12)}... → ${to.slice(0,12)}...`);
    }
});

socket.on("call-ended", ({ to, from }) => {
    const targetId = userSockets[normKey(to)];
    if (targetId) {
        io.to(targetId).emit("call-ended", { from: normKey(from) });
        console.log(`👋 Call ended: ${from.slice(0,12)}... & ${to.slice(0,12)}...`);
    }
});
// ---------------------------------


  // Room and signaling logic remains the same
  socket.on("join", (room) => {
    socket.join(room);
    console.log(`Client ${socket.id} joined ${room}`);
  });

  // Inside server.js
socket.on("auth", ({ room, payload }) => {
  // Log exactly what's received
  console.log(`[SERVER] Received auth for room ${room} from ${socket.id}. Kind: ${payload?.kind}`); // Added log
  try {
    // Log before attempting to emit
    console.log(`[SERVER] Relaying auth (Kind: ${payload?.kind}) to room ${room}...`); // Added log
    // Use io.to(room) to send to everyone in the room including potentially the sender if needed,
    // or socket.to(room) to send to everyone *except* the sender.
    // For auth handshake, io.to(room) or socket.to(room).emit should both work if both clients joined. Let's stick with socket.to for now.
    socket.to(room).emit("auth", { room, payload });
    console.log(`[SERVER] Successfully emitted auth to room ${room}.`); // Added log
  } catch (error) {
    console.error(`[SERVER] Error emitting auth to room ${room}:`, error); // Added error log
  }
});

// ALSO add logging for the 'signal' handler for WebRTC messages:
socket.on("signal", ({ room, payload }) => {
  console.log(`[SERVER] Received signal for room ${room} from ${socket.id}.`); // Added log
  console.log(`[SERVER] Relaying signal to room ${room}...`); // Added log
  socket.to(room).emit("signal", { room, payload }); // Assuming payload includes 'from' etc needed by client
  console.log(`[SERVER] Successfully emitted signal to room ${room}.`); // Added log
});

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    const pubKey = socket.data.pubKey;

    if (pubKey) {
      // --- 1. Notify subscribers that this user is now offline ---
      const subscribers = presenceSubscriptions[pubKey];
      if (subscribers && subscribers.length) {
        console.log(`📢 Notifying ${subscribers.length} subscribers that ${pubKey.slice(0,12)}... is offline.`);
        subscribers.forEach(subscriberSocketId => {
          io.to(subscriberSocketId).emit("presence-update", { pubKey: pubKey, status: "offline" });
        });
      }

      // --- 2. Clean up all subscriptions this socket made ---
      const subscriptionsMadeByThisSocket = socketSubscriptions[socket.id];
      if (subscriptionsMadeByThisSocket && subscriptionsMadeByThisSocket.length) {
        subscriptionsMadeByThisSocket.forEach(subscribedToKey => {
          if (presenceSubscriptions[subscribedToKey]) {
            presenceSubscriptions[subscribedToKey] = presenceSubscriptions[subscribedToKey].filter(id => id !== socket.id);
            if (presenceSubscriptions[subscribedToKey].length === 0) {
              delete presenceSubscriptions[subscribedToKey];
            }
          }
        });
      }
      delete socketSubscriptions[socket.id];

      // --- 3. Finally, remove user from the main online list ---
      delete userSockets[pubKey];
      console.log(`🗑️ Unregistered and cleaned up subscriptions for: ${pubKey.slice(0, 12)}...`);
    }
  });
});

const PORT = process.env.PORT || 3000;

// Connect to MongoDB *before* starting the HTTP server
connectToMongo().then(() => {
    server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}).catch(err => {
    console.error("🚨 MongoDB connection failed on startup. Server not started.", err);
});

// --- Add graceful shutdown for MongoDB ---
process.on('SIGINT', async () => {
    console.log("🔌 Shutting down server...");
    await mongoClient.close();
    console.log("🔒 MongoDB connection closed.");
    process.exit(0);
});
