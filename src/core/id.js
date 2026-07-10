// ID 生成：带类型前缀的随机串（api-contract.md 通用约定）。

import { randomBytes } from "node:crypto";

function randomToken(length = 10) {
  return randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
}

function makeId(prefix) {
  return `${prefix}_${randomToken(10)}`;
}

export const newAgentId = () => makeId("agt");
export const newAccountId = () => makeId("acc");
export const newSpaceId = () => makeId("spc");
export const newMessageId = () => makeId("msg");
export const newRunId = () => makeId("run");
export const newActivityId = () => makeId("act");
export const newApprovalId = () => makeId("apr");
export const newThemeId = () => makeId("thm");
