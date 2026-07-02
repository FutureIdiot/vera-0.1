// 极简手写路由：node:http 上按 method + path（支持 :param）分发到 handler。
// 不引入 express/fastify（package.json 零运行时依赖）。

function compile(path) {
  const keys = [];
  const pattern = path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        keys.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${pattern}$`), keys };
}

export function createRouter() {
  const routes = [];

  function add(method, path, handler) {
    const { regex, keys } = compile(path);
    routes.push({ method, regex, keys, handler });
  }

  const router = {
    get: (path, handler) => add("GET", path, handler),
    post: (path, handler) => add("POST", path, handler),
    patch: (path, handler) => add("PATCH", path, handler),
    delete: (path, handler) => add("DELETE", path, handler),
  };

  // 返回 true 表示已匹配并交给 handler 处理（无论 handler 内部是否报错），
  // false 表示没有路由匹配，调用方（server.js）负责 404。
  router.handle = async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      const params = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1]);
      });
      await route.handler({ req, res, params, query: url.searchParams });
      return true;
    }
    return false;
  };

  return router;
}
