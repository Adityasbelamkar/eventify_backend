import express from "express";
import mongoose from "mongoose";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || "127.0.0.1";
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/eventify";

// ---------- Security & middleware ----------
app.use(helmet());
app.use(express.json({ limit: "10kb" }));

// CORS: allow all by default (works when opening main.html from filesystem)
const allowed = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // allow same-origin / file://
      if (allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: false
  })
);

// Basic rate limits for API routes
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
});
app.use("/api/", limiter);

// ---------- DB ----------
mongoose.set("strictQuery", true);
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  });

// ---------- Models ----------
const bookingSchema = new mongoose.Schema(
  {
    eventTitle: { type: String, required: true, trim: true, maxlength: 200 },
    userEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 200,
      validate: {
        validator: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
        message: "Invalid email format"
      }
    },
    status: { type: String, enum: ["confirmed", "cancelled"], default: "confirmed" }
  },
  { timestamps: true }
);

const Booking = mongoose.model("Booking", bookingSchema);

// ---------- Helpers ----------
const sanitizeTitle = s => (s || "").toString().trim().slice(0, 200);

// ---------- Routes ----------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * POST /api/book
 * body: { eventTitle, userEmail }
 * returns: { ok: true, booking }
 */
app.post("/api/book", async (req, res) => {
  try {
    const eventTitle = sanitizeTitle(req.body?.eventTitle);
    const userEmail = (req.body?.userEmail || "").toLowerCase().trim();

    if (!eventTitle || !userEmail) {
      return res.status(400).json({ ok: false, error: "eventTitle and userEmail are required" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail)) {
      return res.status(400).json({ ok: false, error: "Invalid email" });
    }

    const booking = await Booking.create({ eventTitle, userEmail });
    res.status(201).json({ ok: true, booking });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

/**
 * GET /api/bookings?userEmail=...
 * returns: Booking[]
 */
app.get("/api/bookings", async (req, res) => {
  try {
    const userEmail = (req.query.userEmail || "").toLowerCase().trim();
    if (!userEmail) {
      return res.status(400).json({ ok: false, error: "userEmail query param is required" });
    }
    const list = await Booking.find({ userEmail }).sort({ createdAt: -1 }).lean();
    // The frontend expects a `date` field; map createdAt -> date for compatibility
    const shaped = list.map(b => ({
      ...b,
      date: b.createdAt,
    }));
    res.json(shaped);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// 404 fallback
app.use((req, res) => res.status(404).json({ ok: false, error: "Not found" }));

// ---------- Start ----------
app.listen(PORT, HOST, () => {
  console.log(`🚀 Server running at http://${HOST}:${PORT}`);
});
