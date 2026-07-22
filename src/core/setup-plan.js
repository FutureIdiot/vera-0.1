import { setupFingerprint } from "./setup-state.js";

const SEVERITY = { ready: 0, remediation_required: 1, blocked: 2 };

function check(id, status, summary, detail) {
  return Object.freeze({ id, status, summary, detail });
}

function majorNodeVersion(version) {
  const match = /^v?(\d+)(?:\.|$)/u.exec(version ?? "");
  return match ? Number(match[1]) : null;
}

function listenerPort(listener) {
  const match = /:(\d+)$/u.exec(listener);
  return match ? Number(match[1]) : null;
}

function targetChecks(input, target, snapshot) {
  const { facts } = snapshot;
  const checks = [];
  checks.push(check(
    "management-connection",
    "ready",
    "管理连接可用",
    target.connection.kind === "ssh" ? "SSH固定只读探针已完成；未改变SSH认证或配置" : "本机固定只读探针已完成",
  ));

  const serverRole = target.role === "gateway" || target.role === "daemon";
  checks.push(serverRole && facts.os !== "Linux"
    ? check("operating-system", "blocked", "宿主系统不受支持", `当前${facts.os || "unknown"}；gateway/daemon首版只支持Linux`)
    : check("operating-system", "ready", "宿主系统已识别", `${facts.os}/${facts.arch}`));
  if (serverRole && facts.systemdState === "unavailable") {
    checks.push(check("service-manager", "blocked", "systemd manager不可用", "gateway/daemon首版没有其他service manager实现；仅有systemctl二进制不算可用"));
  } else if (serverRole && facts.systemdState === "degraded") {
    checks.push(check("service-manager", "remediation_required", "systemd处于degraded", "manager可通信，但应用前必须定位失败unit"));
  } else {
    checks.push(check("service-manager", "ready", "service manager检查完成", serverRole ? "systemd manager运行中" : "client角色不要求systemd"));
  }
  if (!facts.serviceScanAvailable) {
    checks.push(check("service-scan", serverRole ? "blocked" : "remediation_required", "无法读取service清单", "不能证明既有Vera或代理service为空"));
  } else {
    checks.push(check("service-scan", "ready", "service清单读取完成", "仅保留Vera与常见代理unit的安全名称和启用状态"));
  }

  const nodeMajor = majorNodeVersion(facts.nodeVersion);
  if (nodeMajor === null) checks.push(check("node", "remediation_required", "Node.js不可用", "宿主准备阶段需安装受支持的Node.js 20或更高版本"));
  else if (nodeMajor < 20) checks.push(check("node", "remediation_required", "Node.js版本过低", `检测到${facts.nodeVersion}；需要20或更高版本`));
  else checks.push(check("node", "ready", "Node.js版本满足要求", facts.nodeVersion));

  if (snapshot.clockDeltaMs > 5 * 60 * 1000) {
    checks.push(check("clock", "remediation_required", "宿主时钟偏差过大", `与控制端相差约${Math.round(snapshot.clockDeltaMs / 1000)}秒`));
  } else {
    checks.push(check("clock", "ready", "宿主时钟偏差可接受", `与控制端相差约${Math.round(snapshot.clockDeltaMs / 1000)}秒`));
  }

  for (const pathFact of facts.paths) {
    if (pathFact.hasSymlink) {
      checks.push(check(`path-${pathFact.name}`, "blocked", `${pathFact.name}路径含符号链接`, pathFact.path));
    } else if (pathFact.kind === "other") {
      checks.push(check(`path-${pathFact.name}`, "blocked", `${pathFact.name}路径被非目录对象占用`, pathFact.path));
    } else if (pathFact.availableKb === null) {
      checks.push(check(`path-${pathFact.name}`, "blocked", `${pathFact.name}路径磁盘状态未知`, pathFact.path));
    } else if (!pathFact.writable) {
      checks.push(check(`path-${pathFact.name}`, "remediation_required", `${pathFact.name}路径需准备权限`, `${pathFact.path}；当前控制用户权限推断不可写，尚未验证未来service user`));
    } else {
      checks.push(check(`path-${pathFact.name}`, "remediation_required",
        pathFact.kind === "missing" ? `${pathFact.name}目录尚未创建` : `${pathFact.name}目录仍需验证service user权限`,
        `${pathFact.path}；剩余${pathFact.availableKb} KiB，当前控制用户权限仅为只读推断`));
    }
  }

  if (!facts.listenerScanAvailable) {
    checks.push(check("listeners", serverRole ? "blocked" : "remediation_required", "无法读取监听端口", "不能证明3210/443没有未知冲突"));
  } else {
    const relevant = facts.listeners.filter((value) => [80, 443, 3000, 3210].includes(listenerPort(value)));
    checks.push(relevant.length > 0
      ? check("listeners", "blocked", "目标端口已有未知监听", relevant.join(", "))
      : check("listeners", "ready", "目标端口未发现监听", "80、443、3000、3210未发现占用；进程归属将在应用前重验"));
  }

  if (facts.serviceScanAvailable) {
    const proxyServices = facts.services.filter((item) => /^(?:cloudflared|nginx|caddy)/u.test(item.name));
    const veraServices = facts.services.filter((item) => item.name.startsWith("vera"));
    if (proxyServices.length > 0) {
      checks.push(check("proxy-services", "blocked", "发现用途未知的代理service", proxyServices.map((item) => item.name).join(", ")));
    } else checks.push(check("proxy-services", "ready", "未发现常见旧代理service", "cloudflared/nginx/caddy候选为空"));
    if (veraServices.length > 0) {
      checks.push(check("vera-services", "remediation_required", "发现既有Vera service", `${veraServices.map((item) => item.name).join(", ")}；应用前必须先定位并冷备`));
    } else checks.push(check("vera-services", "ready", "未发现既有Vera service", "unit名称候选为空"));
  }

  if (!facts.tailscale.installed) {
    checks.push(check("tailscale-host", "remediation_required", "Tailscale未安装", "需由宿主准备或官方流程安装"));
  } else if (!facts.tailscale.active) {
    checks.push(check("tailscale-host", "remediation_required", "Tailscale尚未登录", "需在外部官方授权流程完成登录"));
  } else if (facts.tailscale.serve === "unavailable") {
    checks.push(check("tailscale-host", "remediation_required", "Tailscale Serve状态不可读", "本机已登录，但Serve权限或状态仍需人工确认"));
  } else {
    checks.push(check("tailscale-host", "ready", "Tailscale本机状态可用", `Serve状态：${facts.tailscale.serve}`));
  }
  checks.push(check(
    "tailnet-policy",
    "remediation_required",
    input.tailnet === "new" ? "新tailnet需要外部授权" : "tailnet权限仍需端到端确认",
    "只读宿主探针不能证明MagicDNS、HTTPS、ACL与owner login访问；后续必须从owner设备实测",
  ));
  return checks;
}

function planActions(target, checks) {
  const actions = [];
  const add = (id, status, action, backup, verify) => actions.push(Object.freeze({ id, targetId: target.id, status, action, backup, verify }));
  const relevant = (prefix) => checks.filter((item) => item.id.startsWith(prefix));
  const worst = (items) => items.reduce((result, item) => SEVERITY[item.status] > SEVERITY[result] ? item.status : result, "ready");

  if (target.role === "client") {
    add("tailnet.prepare", worst(relevant("tail")),
      "完成官方Tailscale授权并确认MagicDNS、HTTPS、ACL和owner login",
      "不接管或保存Tailscale账号凭证/auth key",
      "从owner设备访问gateway私网HTTPS并验证SSE恢复");
    add("client.connect", checks.some((item) => item.status === "blocked") ? "blocked" : "remediation_required",
      "登记纯客户端访问；不创建服务端目录、service或hostId",
      "客户端接入不迁移或覆盖gateway数据",
      "验证owner身份、页面加载、消息流和断线恢复");
    return actions;
  }

  add("host.prepare", worst(checks.filter((item) => ["node", "service-manager", "service-scan"].includes(item.id) || item.id.startsWith("path-"))),
    "准备受支持Node、专用角色目录和service user权限；不触碰未识别对象",
    "任何既有Vera目录或service改变前先做可定位冷备份",
    "重跑固定探针并以未来service user做可回收写入验证");
  add("tailnet.prepare", worst(relevant("tail")),
    "完成官方Tailscale授权并确认MagicDNS、HTTPS、ACL和owner login",
    "不接管或保存Tailscale账号凭证/auth key",
    "从owner设备与目标宿主分别验证管理连接");
  const networkStatus = worst(checks.filter((item) => ["listeners", "proxy-services", "service-scan", "tailnet-policy"].includes(item.id)));
  add("network.harden", networkStatus === "ready" ? "remediation_required" : networkStatus,
    "仅在tailnet管理连接实测后停用已精确识别的旧Vera公网入口",
    "先备份Vera相关代理/service定义；未知代理保持不动并阻断执行",
    "重新连接并验证公网IP、3210和443均无Vera入口");
  add(`${target.role}.apply`, checks.some((item) => item.status === "blocked") ? "blocked" : "remediation_required",
    `安装并配置${target.role}角色；本切片尚未提供apply实现`,
    "应用前重新探测；替换任何Vera对象前必须已有可读冷备份",
    target.role === "gateway" ? "依次验证回环health、Serve、owner身份、SSE与公网不可达" : "验证角色连接、重启恢复和权限边界");
  return actions;
}

export function buildSetupPlan(input, snapshots, snapshotFingerprint) {
  const targets = input.targets.map((target) => {
    const snapshot = snapshots.find((item) => item.targetId === target.id);
    if (!snapshot) throw Object.assign(new Error(`missing snapshot for ${target.id}`), { code: "invalid_setup_plan" });
    const checks = targetChecks(input, target, snapshot);
    return Object.freeze({
      id: target.id,
      role: target.role,
      transport: target.connection.kind,
      paths: target.paths,
      checks: Object.freeze(checks),
      actions: Object.freeze(planActions(target, checks)),
    });
  });
  const allChecks = targets.flatMap((target) => target.checks);
  const status = allChecks.reduce((result, item) => SEVERITY[item.status] > SEVERITY[result] ? item.status : result, "ready");
  const body = {
    schemaVersion: 1,
    toolVersion: "0.0.1",
    stage: "planned",
    status,
    snapshotFingerprint,
    tailnet: input.tailnet,
    ownerLogin: input.ownerLogin,
    targets,
    applied: false,
  };
  return Object.freeze({ ...body, planId: setupFingerprint(body) });
}
