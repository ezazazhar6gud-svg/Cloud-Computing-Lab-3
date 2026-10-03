// Velora API (reads/writes the Netlify Database)
//   GET  /api/site   -> page texts, menu, cars + specs, features
//   GET  /api/stats  -> counts, latest bookings, latest activity
//   POST /api/log    -> records a model click / throttle move (trigger raises view_count)
//   POST /api/book   -> saves a customer + test-drive booking
import { getDatabase } from "@netlify/database";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const SLOTS = ["Morning", "Afternoon", "Sunset"];
const clean = (v, max) => String(v ?? "").trim().slice(0, max);

export default async (req) => {
  const route = new URL(req.url).pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const pool = getDatabase().pool;

  try {
    if (req.method === "GET" && route === "site") {
      const [settings, nav, models, features] = await Promise.all([
        pool.query("SELECT setting_key, setting_value FROM site_settings"),
        pool.query("SELECT label, target FROM nav_links WHERE is_active ORDER BY sort_order, link_id"),
        pool.query("SELECT * FROM v_model_spec_sheet ORDER BY model_id"),
        pool.query("SELECT title, description FROM features ORDER BY sort_order, feature_id"),
      ]);
      return json({
        settings: Object.fromEntries(settings.rows.map((r) => [r.setting_key, r.setting_value])),
        nav: nav.rows,
        models: models.rows,
        features: features.rows,
      });
    }

    if (req.method === "GET" && route === "stats") {
      const [counts, bookings, activity] = await Promise.all([
        pool.query(`SELECT (SELECT COUNT(*) FROM customers)::int AS customers,
                           (SELECT COUNT(*) FROM test_drive_bookings)::int AS bookings,
                           (SELECT COUNT(*) FROM interaction_log)::int AS interactions`),
        pool.query(`SELECT split_part(c.full_name, ' ', 1) AS first_name, m.model_name,
                           b.drive_date::text AS drive_date, b.time_slot, b.status
                    FROM test_drive_bookings b
                    JOIN customers  c ON c.customer_id = b.customer_id
                    JOIN car_models m ON m.model_id    = b.model_id
                    ORDER BY b.created_at DESC, b.booking_id DESC LIMIT 5`),
        pool.query(`SELECT m.model_name, l.action_type, l.speed_kmh, l.logged_at
                    FROM interaction_log l
                    JOIN car_models m ON m.model_id = l.model_id
                    ORDER BY l.log_id DESC LIMIT 6`),
      ]);
      return json({ counts: counts.rows[0], bookings: bookings.rows, activity: activity.rows });
    }

    if (req.method === "POST" && route === "log") {
      const body = await req.json().catch(() => ({}));
      const modelId = Number.parseInt(body.model_id, 10);
      const throttle = Math.max(0, Math.min(100, Math.round(Number(body.throttle) || 0)));
      const action = body.action === "throttle_change" ? "throttle_change" : "model_select";
      if (!Number.isInteger(modelId)) return json({ ok: false, error: "model_id required" }, 400);

      const exists = await pool.query("SELECT 1 FROM car_models WHERE model_id = $1", [modelId]);
      if (!exists.rowCount) return json({ ok: false, error: "Unknown model" }, 400);

      await pool.query(
        "INSERT INTO interaction_log (model_id, throttle_value, speed_kmh, action_type) VALUES ($1, $2, $3, $4)",
        [modelId, throttle, Math.round(throttle * 2.4), action]
      );
      const v = await pool.query("SELECT view_count FROM car_models WHERE model_id = $1", [modelId]);
      return json({ ok: true, view_count: v.rows[0].view_count });
    }

    if (req.method === "POST" && route === "book") {
      const b = await req.json().catch(() => ({}));
      const name = clean(b.full_name, 80);
      const email = clean(b.email, 120).toLowerCase();
      const phone = clean(b.phone, 25) || null;
      const city = clean(b.city, 60) || null;
      const modelId = Number.parseInt(b.model_id, 10);
      const date = clean(b.drive_date, 10);
      const slot = SLOTS.includes(b.time_slot) ? b.time_slot : "Sunset";

      if (name.length < 2) return json({ ok: false, error: "Please enter your name." }, 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: "Please enter a valid email." }, 400);
      if (!Number.isInteger(modelId)) return json({ ok: false, error: "Please choose a model." }, 400);
      const parsed = new Date(date + "T00:00:00Z");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
        return json({ ok: false, error: "Please choose a valid date." }, 400);

      const client = await pool.connect();
      try {
        const m = await client.query("SELECT 1 FROM car_models WHERE model_id = $1 AND is_active", [modelId]);
        if (!m.rowCount) return json({ ok: false, error: "That model is not available." }, 400);
        const future = await client.query("SELECT $1::date >= CURRENT_DATE AS ok", [date]);
        if (!future.rows[0].ok) return json({ ok: false, error: "Please choose today or a future date." }, 400);

        await client.query("BEGIN");
        const c = await client.query(
          `INSERT INTO customers (full_name, email, phone, city) VALUES ($1, $2, $3, $4)
           ON CONFLICT (email) DO UPDATE
             SET phone = COALESCE(EXCLUDED.phone, customers.phone),
                 city  = COALESCE(EXCLUDED.city,  customers.city)
           RETURNING customer_id`,
          [name, email, phone, city]
        );
        const bk = await client.query(
          `INSERT INTO test_drive_bookings (customer_id, model_id, drive_date, time_slot)
           VALUES ($1, $2, $3, $4) RETURNING booking_id, status`,
          [c.rows[0].customer_id, modelId, date, slot]
        );
        await client.query("COMMIT");
        return json({ ok: true, booking_id: bk.rows[0].booking_id, status: bk.rows[0].status });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    return json({ ok: false, error: "Not found" }, 404);
  } catch (err) {
    return json({ ok: false, error: "Server error" }, 500);
  }
};

export const config = { path: ["/api/site", "/api/stats", "/api/log", "/api/book"] };
