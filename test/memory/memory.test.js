import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryVault } from "../../src/memory/memory.js";

// 所有测试用临时目录当 vaultPath，绝不读写真实的 ~/.vera/memory。
async function withVault(fn, { residentIndexMaxLines } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "vera-memory-test-"));
  const vaultPath = join(dir, "vault"); // 故意不预先创建，覆盖“目录不存在”场景
  try {
    await fn(createMemoryVault({ vaultPath, residentIndexMaxLines }), vaultPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("saveMemory + listMemories round-trip including stains and colon-bearing description", async () => {
  await withVault(async (memory) => {
    const saved = await memory.saveMemory({
      slug: "bubble-split-rule",
      type: "decision",
      description: "切分规则：按段落边界，无边界则就近空格软切",
      content: "正文见 [[bubble-split-rule]]，仍待补充。",
      stains: { agt_x1y2: "#7A8FA6" },
    });
    assert.equal(saved.slug, "bubble-split-rule");
    assert.equal(saved.status, "active");
    assert.deepEqual(saved.stains, { agt_x1y2: "#7A8FA6" });

    const list = await memory.listMemories();
    assert.equal(list.length, 1);
    const entry = list[0];
    assert.equal(entry.slug, "bubble-split-rule");
    assert.equal(entry.type, "decision");
    assert.equal(entry.description, "切分规则：按段落边界，无边界则就近空格软切");
    assert.equal(entry.status, "active");
    assert.deepEqual(entry.stains, { agt_x1y2: "#7A8FA6" });
    assert.ok(entry.createdAt && entry.updatedAt);
  });
});

test("written file has frontmatter + blank line + body shape, colon value gets quoted", async () => {
  await withVault(async (memory, vaultPath) => {
    await memory.saveMemory({
      slug: "quote-check",
      type: "preference",
      description: "含冒号(ascii ':')的钩子需要加引号",
      content: "body text",
    });
    const raw = await readFile(join(vaultPath, "quote-check.md"), "utf8");
    assert.match(raw, /^---\n/);
    assert.match(raw, /description: "含冒号\(ascii ':'\)的钩子需要加引号"/);
    assert.match(raw, /createdAt: \d{4}-\d{2}-\d{2}T/, "timestamps stay unquoted per contract example");
    assert.match(raw, /\n\nbody text/);
  });
});

test("scalar containing newline is quoted, stays single-line, and round-trips exactly", async () => {
  await withVault(async (memory, vaultPath) => {
    // 换行不加引号会把标量拆成多行：parse 回来静默截断，溢出行含冒号还会
    // 变成假字段。必须走 JSON.stringify 引号路径（\n 转义成两个字符）。
    const tricky = "第一行\n第二行: 看着像字段\t还有制表符";
    await memory.saveMemory({
      slug: "newline-check",
      type: "decision",
      description: tricky,
      content: "body",
    });

    const raw = await readFile(join(vaultPath, "newline-check.md"), "utf8");
    // 文件里 description 必须还是一行（\n 被转义），不产生假字段行
    const descLine = raw.split("\n").find((l) => l.startsWith("description:"));
    assert.ok(descLine, "description line exists");
    assert.match(descLine, /^description: "/);
    assert.ok(!raw.split("\n").some((l) => l.startsWith("第二行")), "no overflow line leaked into frontmatter");

    const list = await memory.listMemories();
    assert.equal(list[0].description, tricky, "round-trip must be character-exact");
  });
});

test("YAML indicator first-chars and ambiguous literals round-trip via quoting", async () => {
  await withVault(async (memory) => {
    // 首字符 indicator：裸写会被真 YAML（如 Obsidian）读成列表 / 锚 / 标签等；
    // true/false/null/yes/no/~/纯数字：裸写会被读成布尔 / 空值 / 数字类型。
    const trickyValues = [
      "- 像列表项",
      "? 像复杂键",
      ", 逗号开头",
      "& 像锚点",
      "* 像别名",
      "! 像标签",
      "| 像块标量",
      "> 像折叠标量",
      "% 像指令",
      "@ 保留字符",
      "` 保留字符",
      "true",
      "False",
      "null",
      "yes",
      "NO",
      "~",
      "42",
      "3.14",
      "-1",
      "1e3",
    ];
    for (let i = 0; i < trickyValues.length; i += 1) {
      await memory.saveMemory({
        slug: `tricky-${i}`,
        type: "decision",
        description: trickyValues[i],
        content: "body",
      });
    }

    const list = await memory.listMemories();
    const bySlug = new Map(list.map((m) => [m.slug, m.description]));
    for (let i = 0; i < trickyValues.length; i += 1) {
      assert.equal(bySlug.get(`tricky-${i}`), trickyValues[i], `round-trip of ${JSON.stringify(trickyValues[i])}`);
    }
  });
});

test("saveMemory rejects non-kebab-case slug with invalid_request", async () => {
  await withVault(async (memory) => {
    await assert.rejects(
      () => memory.saveMemory({ slug: "Not_Kebab", type: "bug", description: "x", content: "y" }),
      (err) => {
        assert.equal(err.code, "invalid_request");
        return true;
      },
    );
  });
});

test("saveMemory rejects duplicate slug with conflict", async () => {
  await withVault(async (memory) => {
    await memory.saveMemory({ slug: "dup-slug", type: "bug", description: "first", content: "a" });
    await assert.rejects(
      () => memory.saveMemory({ slug: "dup-slug", type: "bug", description: "second", content: "b" }),
      (err) => {
        assert.equal(err.code, "conflict");
        return true;
      },
    );
  });
});

test("listMemories sorts by updatedAt descending and tolerates a corrupt file", async () => {
  await withVault(async (memory, vaultPath) => {
    await mkdir(vaultPath, { recursive: true });

    await writeFile(
      join(vaultPath, "old-one.md"),
      "---\ntype: decision\ndescription: 旧的\nstatus: active\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\nold body\n",
      "utf8",
    );
    await writeFile(
      join(vaultPath, "new-one.md"),
      "---\ntype: decision\ndescription: 新的\nstatus: active\ncreatedAt: 2026-06-01T00:00:00.000Z\nupdatedAt: 2026-06-01T00:00:00.000Z\n---\n\nnew body\n",
      "utf8",
    );
    // 缺 frontmatter 结束标记的坏文件：不应让 listMemories 崩溃
    await writeFile(join(vaultPath, "broken.md"), "---\ntype: decision\nno closing marker here", "utf8");

    const list = await memory.listMemories();
    assert.equal(list.length, 3);
    assert.equal(list[0].slug, "new-one");
    assert.equal(list[1].slug, "old-one");
    // broken.md 解析为空 frontmatter，description 落空串、状态兜底 active
    const broken = list.find((m) => m.slug === "broken");
    assert.ok(broken);
    assert.equal(broken.description, "");
    assert.equal(broken.status, "active");
  });
});

test("listMemories returns empty array when vault directory does not exist", async () => {
  await withVault(async (memory) => {
    const list = await memory.listMemories();
    assert.deepEqual(list, []);
  });
});

test("residentIndex excludes archived entries and returns null on empty vault", async () => {
  await withVault(
    async (memory, vaultPath) => {
      const empty = await memory.residentIndex();
      assert.equal(empty, null);

      for (let i = 0; i < 5; i += 1) {
        await memory.saveMemory({
          slug: `fact-${i}`,
          type: "decision",
          description: `钩子 ${i}`,
          content: "body",
        });
      }
      await memory.saveMemory({
        slug: "archived-fact",
        type: "decision",
        description: "已归档，不应出现",
        content: "body",
      });
      // 手动把 archived-fact 标记为 archived（模拟用户在 Obsidian 里编辑文件）
      const raw = await readFile(join(vaultPath, "archived-fact.md"), "utf8");
      await writeFile(join(vaultPath, "archived-fact.md"), raw.replace("status: active", "status: archived"), "utf8");

      const index = await memory.residentIndex();
      assert.ok(index);
      assert.match(index, /相关时用你的文件工具展开 \[\[slug\]\]/);
      assert.ok(!index.includes("archived-fact"));
      // maxLines 默认 25，5 条全部在列
      for (let i = 0; i < 5; i += 1) {
        assert.ok(index.includes(`[[fact-${i}]]`), `expected fact-${i} in index`);
      }
    },
    { residentIndexMaxLines: 25 },
  );
});

test("residentIndex truncates when memory count exceeds configured max lines", async () => {
  await withVault(
    async (memory) => {
      for (let i = 0; i < 5; i += 1) {
        // updatedAt 靠写入顺序自然递增（saveMemory 用 Date.now）
        await memory.saveMemory({ slug: `item-${i}`, type: "decision", description: `d${i}`, content: "c" });
      }
      const index = await memory.residentIndex();
      const lines = index.split("\n").filter((l) => l.startsWith("- [["));
      assert.equal(lines.length, 3, "should truncate to residentIndexMaxLines");
    },
    { residentIndexMaxLines: 3 },
  );
});

test("residentIndex returns null when all memories are archived", async () => {
  await withVault(async (memory, vaultPath) => {
    await memory.saveMemory({ slug: "only-one", type: "decision", description: "d", content: "c" });
    const raw = await readFile(join(vaultPath, "only-one.md"), "utf8");
    await writeFile(join(vaultPath, "only-one.md"), raw.replace("status: active", "status: archived"), "utf8");

    const index = await memory.residentIndex();
    assert.equal(index, null);
  });
});
