const PROXY_CONFIG = {
  "/archidekt": {
    "target": "https://archidekt.com",
    "secure": false,
    "changeOrigin": true,
    "pathRewrite": {
      "^/archidekt": ""
    },
    "onProxyReq": function(pr, req, res) {
      pr.removeHeader('Origin');
    }
  }
}
module.exports = PROXY_CONFIG;
