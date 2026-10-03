// Velora API
//   GET  /api/site  -> page texts, nav, models + specs, features
//   POST /api/log   -> records a model click / throttle move, returns new view_count
import { getDatabase } from "@netlify/database";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

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

    if (req.method === "POST" && route === "log") {
      const body = await req.json().catch(() => ({}));
      const modelId = Number.parseInt(body.model_id, 10);
      const throttle = Math.max(0, Math.min(100, Math.round(Number(body.throttle) || 0)));
      const action = body.action === "throttle_change" ? "throttle_change" : "model_select";
      if (!Number.isInteger(modelId)) return json({ ok: false, error: "model_id required" }, 400);

      await pool.query(
        "INSERT INTO interaction_log (model_id, throttle_value, speed_kmh, action_type) VALUES ($1, $2, $3, $4)",
        [modelId, throttle, Math.round(throttle * 2.4), action]
      );
      const v = await pool.query("SELECT view_count FROM car_models WHERE model_id = $1", [modelId]);
      return json({ ok: true, view_count: v.rows[0]?.view_count ?? 0 });
    }

    return json({ ok: false, error: "Not found" }, 404);
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 500);
  }
};

export const config = { path: ["/api/site", "/api/log"] };
