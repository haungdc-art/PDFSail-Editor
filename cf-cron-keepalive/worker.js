/**
 * Cloudflare Cron Worker — 每 10 分钟 ping Render 服务防止 Free Tier 休眠
 *
 * 部署：npx wrangler deploy
 * 查看日志：npx wrangler tail
 */
export default {
  async scheduled(event, env, ctx) {
    const url = "https://pdfsail-editor.onrender.com/api/health";
    try {
      const resp = await fetch(url, { method: "GET" });
      console.log(`[${new Date().toISOString()}] Health check: ${resp.status}`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Health check failed:`, e.message);
    }
  },
};
