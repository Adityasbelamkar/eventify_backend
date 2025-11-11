import express from "express";
import mongoose from "mongoose";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// --- Config (Render provides PORT) ---
const PORT = process.env.PORT || 8080;
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/eventify";

app.set("trust proxy", 1);

// ---------- Security & middleware ----------
app.use(helmet());
app.use(express.json({ limit: "10kb" }));

// CORS: allowlist via env, or allow all if not set
const allowed = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin / server-to-server
      if (allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "DELETE", "PUT", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  })
);

const limiter = rateLimit({ windowMs: 60 * 1000, max: 100 });
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
const eventSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    city: { type: String, required: true, trim: true, maxlength: 100 },
    date: { type: String, required: true, trim: true }, // yyyy-mm-dd
    price: { type: Number, required: true, min: 0 },
    venue: { type: String, required: true, trim: true, maxlength: 200 },
    image: { type: String, trim: true, maxlength: 500 },
    description: { type: String, trim: true, maxlength: 1000 },
    status: { type: String, enum: ["active", "deleted"], default: "active" }, // soft delete
  },
  { timestamps: true }
);

const bookingSchema = new mongoose.Schema(
  {
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: "Event" }, // optional but useful
    eventTitle: { type: String, required: true, trim: true, maxlength: 200 },
    userEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 200,
      validate: {
        validator: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
        message: "Invalid email format",
      },
    },
    quantity: { type: Number, default: 1, min: 1, max: 10 },
    status: { type: String, enum: ["confirmed", "cancelled"], default: "confirmed" },
  },
  { timestamps: true }
);

const Event = mongoose.model("Event", eventSchema);
const Booking = mongoose.model("Booking", bookingSchema);

// ---------- Helpers ----------
const sanitizeTitle = s => (s || "").toString().trim().slice(0, 200);
const clampQty = q => {
  const n = Number(q);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(10, Math.trunc(n)));
};
const pickQuantity = body =>
  clampQty(
    body?.quantity ??
      body?.qty ??
      body?.tickets ??
      body?.numTickets ??
      body?.ticketCount ??
      1
  );

// ---------- Routes ----------
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "eventify-backend", time: new Date().toISOString() });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/* ===== Events ===== */

// GET /api/events  (list active)
app.get("/api/events", async (_req, res) => {
  try {
    const list = await Event.find({ status: "active" }).sort({ date: 1 }).lean();
    res.json(list);
  } catch (e) {
    console.error("GET /api/events", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// POST /api/events  (create)
app.post("/api/events", async (req, res) => {
  try {
    const { title, city, date, price, venue, image = "", description = "" } = req.body || {};
    if (!title || !city || !date || price == null || !venue) {
      return res.status(400).json({ ok: false, error: "title, city, date, price, venue required" });
    }
    const doc = await Event.create({ title, city, date, price, venue, image, description });
    res.status(201).json({ ok: true, event: doc });
  } catch (e) {
    console.error("POST /api/events", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// DELETE /api/events/:id?mode=soft|hard
app.delete("/api/events/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const mode = (req.query.mode || "soft").toLowerCase();

    const ev = await Event.findById(id);
    if (!ev || ev.status === "deleted") {
      return res.status(404).json({ ok: false, error: "Event not found" });
    }

    if (mode === "hard") {
      await Event.deleteOne({ _id: id });
      await Booking.deleteMany({ $or: [{ eventId: id }, { eventTitle: ev.title }] });
      return res.json({ ok: true, deleted: "hard", eventId: id });
    } else {
      ev.status = "deleted";
      await ev.save();
      await Booking.updateMany(
        { $or: [{ eventId: id }, { eventTitle: ev.title }], status: { $ne: "cancelled" } },
        { $set: { status: "cancelled" } }
      );
      return res.json({ ok: true, deleted: "soft", eventId: id });
    }
  } catch (e) {
    console.error("DELETE /api/events/:id", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

/* ===== Bookings ===== */

// POST /api/book  body: { eventTitle, userEmail, eventId?, quantity? (aliases ok) }
app.post("/api/book", async (req, res) => {
  try {
    const eventTitle = sanitizeTitle(req.body?.eventTitle);
    const userEmail = (req.body?.userEmail || "").toLowerCase().trim();
    const quantity = pickQuantity(req.body);
    const eventId = req.body?.eventId ? String(req.body.eventId) : undefined;

    if (!eventTitle || !userEmail) {
      return res.status(400).json({ ok: false, error: "eventTitle and userEmail are required" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail)) {
      return res.status(400).json({ ok: false, error: "Invalid email" });
    }

    const booking = await Booking.create({ eventTitle, userEmail, quantity, eventId });
    res.status(201).json({ ok: true, booking });
  } catch (err) {
    console.error("POST /api/book error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// GET /api/bookings?userEmail=...
app.get("/api/bookings", async (req, res) => {
  try {
    const userEmail = (req.query.userEmail || "").toLowerCase().trim();
    if (!userEmail) {
      return res.status(400).json({ ok: false, error: "userEmail query param is required" });
    }
    const list = await Booking.find({ userEmail }).sort({ createdAt: -1 }).lean();
    const shaped = list.map(({ _id, eventId, eventTitle, userEmail, quantity, status, createdAt }) => ({
      _id,
      eventId,
      eventTitle,
      userEmail,
      quantity,
      status,
      date: createdAt,
      createdAt,
    }));
    res.json(shaped);
  } catch (err) {
    console.error("GET /api/bookings error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// DELETE /api/booking/:id  (soft cancel by id)
app.delete("/api/booking/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await Booking.findByIdAndUpdate(id, { $set: { status: "cancelled" } }, { new: true });
    if (!doc) return res.status(404).json({ ok: false, error: "Booking not found" });
    res.json({ ok: true, booking: doc });
  } catch (err) {
    console.error("DELETE /api/booking/:id error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// DELETE /api/booking?bookingId=... OR ?userEmail=&eventTitle=
app.delete("/api/booking", async (req, res) => {
  try {
    const bookingId = req.query.bookingId?.toString().trim();
    const userEmail = (req.query.userEmail || "").toLowerCase().trim();
    const eventTitle = sanitizeTitle(req.query.eventTitle);

    let filter = null;
    if (bookingId) filter = { _id: bookingId };
    else if (userEmail && eventTitle) filter = { userEmail, eventTitle, status: { $ne: "cancelled" } };
    else {
      return res.status(400).json({
        ok: false,
        error: "Provide bookingId or (userEmail and eventTitle) to cancel",
      });
    }

    const doc = await Booking.findOneAndUpdate(filter, { $set: { status: "cancelled" } }, { new: true });
    if (!doc) return res.status(404).json({ ok: false, error: "Booking not found" });

    res.json({ ok: true, booking: doc });
  } catch (err) {
    console.error("DELETE /api/booking error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// POST /api/cancel  body: { bookingId } OR { userEmail, eventTitle }
app.post("/api/cancel", async (req, res) => {
  try {
    const bookingId = (req.body?.bookingId || req.body?._id || req.body?.id || "").toString().trim();
    const userEmail = (req.body?.userEmail || "").toLowerCase().trim();
    const eventTitle = sanitizeTitle(req.body?.eventTitle);

    let filter = null;
    if (bookingId) filter = { _id: bookingId };
    else if (userEmail && eventTitle) filter = { userEmail, eventTitle, status: { $ne: "cancelled" } };
    else {
      return res.status(400).json({
        ok: false,
        error: "Provide bookingId or (userEmail and eventTitle) to cancel",
      });
    }

    const doc = await Booking.findOneAndUpdate(filter, { $set: { status: "cancelled" } }, { new: true });
    if (!doc) return res.status(404).json({ ok: false, error: "Booking not found" });

    res.json({ ok: true, booking: doc });
  } catch (err) {
    console.error("POST /api/cancel error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// 404 fallback
app.use((_req, res) => res.status(404).json({ ok: false, error: "Not found" }));

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`🚀 Server listening on 0.0.0.0:${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received. Closing server...");
  mongoose.connection.close(false, () => {
    console.log("🔌 Mongo connection closed.");
    process.exit(0);
  });
});
