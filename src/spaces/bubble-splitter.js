// 多气泡切分的纯逻辑（api-contract.md「多气泡规则」）：按段落边界切分流式文本。
// 不涉及存储/SSE，方便单测；run-controller 通过 bubble-stream.js 把切分结果
// 落成 Message 记录 + SSE 事件。
//
// 切分策略（边界正则、最小/最大长度）是配置项（core/config.js 的 bubbles 字段），
// 不硬编码。

export function createBubbleSplitter({ boundaryPattern = "\\n\\s*\\n", minLength = 1, maxLength = 800 } = {}) {
  const boundaryRegex = new RegExp(boundaryPattern);
  let buffer = "";

  // 喂入一段增量文本，返回本次新完成（可以定稿）的气泡文本数组（可能为空）。
  // 未完成的剩余文本留在内部 buffer 里，用 peek() 查看，flush() 在 run 结束时收尾。
  function feed(delta) {
    buffer += delta;
    const finished = [];

    // 逐个消费段落边界。
    let match = boundaryRegex.exec(buffer);
    while (match) {
      const candidate = buffer.slice(0, match.index);
      if (candidate.trim().length < minLength) {
        // 内容太短，先不切，等更多文本到达后再看这个边界。
        break;
      }
      finished.push(candidate.trimEnd());
      buffer = buffer.slice(match.index + match[0].length);
      match = boundaryRegex.exec(buffer);
    }

    // 没有边界但文本已经超长：找就近的空格软切，找不到就硬切。
    while (buffer.length > maxLength) {
      let cut = buffer.lastIndexOf(" ", maxLength);
      if (cut < minLength) cut = maxLength;
      finished.push(buffer.slice(0, cut).trimEnd());
      buffer = buffer.slice(cut).replace(/^\s+/, "");
    }

    return finished;
  }

  // run 结束时把剩余 buffer 当作最后一个气泡冲掉。
  function flush() {
    const rest = buffer.trim();
    buffer = "";
    return rest.length ? [rest] : [];
  }

  function peek() {
    return buffer;
  }

  return { feed, flush, peek };
}
