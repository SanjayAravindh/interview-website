(function (globalObject) {
  "use strict";

  function javaStringHashCode(text) {
    let hash = 0;
    const value = String(text);
    for (let i = 0; i < value.length; i++) {
      hash = (Math.imul(hash, 31) + value.charCodeAt(i)) | 0;
    }
    return hash;
  }

  function quote(value) {
    if (value === null) return "null";
    return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  function describeKey(key, capacity) {
    if (key === null) {
      return { hashCode: 0, spread: 0, index: 0, caption: "hash(null) = 0 -> index 0" };
    }
    const hashCode = javaStringHashCode(key);
    const spread = (hashCode ^ (hashCode >>> 16)) | 0;
    const index = (capacity - 1) & spread;
    return {
      hashCode,
      spread,
      index,
      caption: `hash(${quote(key)}) = ${hashCode} ^ (${hashCode} >>> 16) = ${spread} -> index ${index}`,
    };
  }

  function createMap() {
    return {
      capacity: 16,
      threshold: 12,
      size: 0,
      buckets: Array.from({ length: 16 }, () => []),
    };
  }

  function cloneState(map) {
    return {
      capacity: map.capacity,
      threshold: map.threshold,
      size: map.size,
      buckets: map.buckets.map((chain) =>
        chain.map((node) => ({ key: node.key, value: node.value, hash: node.hash }))
      ),
    };
  }

  function step(map, caption, highlight, extra) {
    return {
      caption,
      state: cloneState(map),
      highlight: highlight || null,
      error: !!(extra && extra.error),
      threads: extra && extra.threads ? extra.threads : null,
    };
  }

  function lookup(index) {
    return { bins: [{ index, state: "lookup", label: "lookup" }] };
  }

  function putEntry(map, key, value) {
    const steps = [];
    const info = describeKey(key, map.capacity);
    steps.push(step(map, info.caption, lookup(info.index)));
    const chain = map.buckets[info.index];
    let replaced = false;

    if (chain.length === 0) {
      chain.push({ key, value, hash: info.spread });
      map.size++;
      steps.push(
        step(
          map,
          `bucket ${info.index} is empty -> insert (${quote(key)}, ${quote(value)})`,
          { bins: [{ index: info.index, state: "insert", label: "inserted" }], node: { index: info.index, at: 0 } }
        )
      );
    } else {
      for (let at = 0; at < chain.length; at++) {
        const node = chain[at];
        if (node.key === key) {
          steps.push(
            step(
              map,
              `walk bucket ${info.index}: ${quote(node.key)} matches -> replace value`,
              { bins: [{ index: info.index, state: "walk", label: "walk" }], node: { index: info.index, at } }
            )
          );
          node.value = value;
          replaced = true;
          steps.push(
            step(
              map,
              `replaced ${quote(key)} with ${quote(value)}; size stays ${map.size}`,
              { bins: [{ index: info.index, state: "replace", label: "replaced" }], node: { index: info.index, at } }
            )
          );
          break;
        }
        steps.push(
          step(
            map,
            `walk bucket ${info.index}: ${quote(node.key)} ≠ ${quote(key)}`,
            { bins: [{ index: info.index, state: "walk", label: "walk" }], node: { index: info.index, at } }
          )
        );
      }
      if (!replaced) {
        chain.push({ key, value, hash: info.spread });
        map.size++;
        steps.push(
          step(
            map,
            `no match in bucket ${info.index} -> chain (${quote(key)}, ${quote(value)})`,
            {
              bins: [{ index: info.index, state: "chain", label: "chained" }],
              node: { index: info.index, at: chain.length - 1 },
            }
          )
        );
      }
    }

    if (!replaced && map.size > map.threshold) {
      resize(map, steps);
    } else {
      steps.push(
        step(map, `size ${map.size} is not above threshold ${map.threshold}; no resize`, null)
      );
    }
    return steps;
  }

  function resize(map, steps) {
    const oldCap = map.capacity;
    const oldThreshold = map.threshold;
    const grown = oldCap * 2;
    const parked = [];
    for (let index = 0; index < oldCap; index++) {
      for (const node of map.buckets[index]) parked.push({ index, node });
    }
    map.capacity = grown;
    map.threshold = (grown * 3) / 4;
    map.buckets = Array.from({ length: grown }, () => []);
    for (const entry of parked) map.buckets[entry.index].push(entry.node);

    steps.push(
      step(
        map,
        `size ${map.size} > threshold ${oldThreshold} -> resize; capacity ${oldCap} -> ${grown}, threshold ${map.threshold}`,
        null
      )
    );

    for (let index = 0; index < oldCap; index++) {
      let at = 0;
      while (at < map.buckets[index].length) {
        const node = map.buckets[index][at];
        if ((node.hash & oldCap) === 0) {
          steps.push(
            step(
              map,
              `${quote(node.key)} stays at ${index} (hash & ${oldCap} = 0)`,
              { bins: [{ index, state: "stay", label: "stayed" }], node: { index, at } }
            )
          );
          at++;
        } else {
          map.buckets[index].splice(at, 1);
          const dest = index + oldCap;
          map.buckets[dest].push(node);
          steps.push(
            step(
              map,
              `${quote(node.key)} moves ${index} -> ${dest} (hash & ${oldCap} ≠ 0)`,
              {
                bins: [{ index: dest, state: "move", label: `moved ${index} -> ${dest}` }],
                node: { index: dest, at: map.buckets[dest].length - 1 },
              }
            )
          );
        }
      }
    }
  }

  function getEntry(map, key) {
    const steps = [];
    const info = describeKey(key, map.capacity);
    steps.push(step(map, info.caption, lookup(info.index)));
    const chain = map.buckets[info.index];
    if (!chain.length) {
      steps.push(
        step(map, `bucket ${info.index} is empty -> no entry`, {
          bins: [{ index: info.index, state: "walk", label: "empty" }],
        })
      );
      return steps;
    }
    for (let at = 0; at < chain.length; at++) {
      const node = chain[at];
      const mark = { bins: [{ index: info.index, state: "walk", label: "walk" }], node: { index: info.index, at } };
      if (node.key === key) {
        steps.push(step(map, `walk bucket ${info.index}: ${quote(node.key)} matches -> ${quote(node.value)}`, mark));
        return steps;
      }
      steps.push(step(map, `walk bucket ${info.index}: ${quote(node.key)} ≠ ${quote(key)}`, mark));
    }
    steps.push(
      step(map, `no match in bucket ${info.index} -> no entry`, {
        bins: [{ index: info.index, state: "walk", label: "miss" }],
      })
    );
    return steps;
  }

  function removeEntry(map, key) {
    const steps = [];
    const info = describeKey(key, map.capacity);
    steps.push(step(map, info.caption, lookup(info.index)));
    const chain = map.buckets[info.index];
    for (let at = 0; at < chain.length; at++) {
      const node = chain[at];
      const mark = { bins: [{ index: info.index, state: "walk", label: "walk" }], node: { index: info.index, at } };
      if (node.key === key) {
        steps.push(step(map, `walk bucket ${info.index}: ${quote(node.key)} matches`, mark));
        chain.splice(at, 1);
        map.size--;
        steps.push(
          step(
            map,
            `unlinked ${quote(key)} from bucket ${info.index}; size ${map.size}. HashMap does not shrink.`,
            { bins: [{ index: info.index, state: "remove", label: "removed" }] }
          )
        );
        return steps;
      }
      steps.push(step(map, `walk bucket ${info.index}: ${quote(node.key)} ≠ ${quote(key)}`, mark));
    }
    const empty = chain.length === 0;
    steps.push(
      step(
        map,
        empty ? `bucket ${info.index} is empty -> nothing to remove` : `no match in bucket ${info.index} -> nothing to remove`,
        { bins: [{ index: info.index, state: "walk", label: empty ? "empty" : "miss" }] }
      )
    );
    return steps;
  }

  function applyWrite(map, key, value) {
    const info = describeKey(key, map.capacity);
    const chain = map.buckets[info.index];
    if (!chain.length) {
      chain.push({ key, value, hash: info.spread });
      map.size++;
      return { kind: "cas", index: info.index, at: 0 };
    }
    for (let at = 0; at < chain.length; at++) {
      if (chain[at].key === key) {
        chain[at].value = value;
        return { kind: "replace", index: info.index, at };
      }
    }
    chain.push({ key, value, hash: info.spread });
    map.size++;
    return { kind: "append", index: info.index, at: chain.length - 1 };
  }

  function threadStatus(name, text, other) {
    const slot = name === "Thread B" ? "B" : "A";
    const rest = name === "Thread B" ? "A" : "B";
    return { [slot]: text, [rest]: other || "idle" };
  }

  function nullPut(map, name, key, value) {
    return step(
      map,
      `${name} put(${quote(key)}, ${quote(value)}) throws NullPointerException. Null keys and values are not allowed.`,
      null,
      { error: true, threads: threadStatus(name, "NullPointerException", "idle") }
    );
  }

  function putOne(map, name, key, value) {
    if (key === null || value === null) return [nullPut(map, name, key, value)];
    const info = describeKey(key, map.capacity);
    const steps = [];
    steps.push(step(map, `${name}: ${info.caption}`, lookup(info.index), { threads: threadStatus(name, "hashing") }));
    const chain = map.buckets[info.index];
    if (!chain.length) {
      chain.push({ key, value, hash: info.spread });
      map.size++;
      steps.push(
        step(
          map,
          `${name}: bin ${info.index} is empty -> CAS the node in, no lock`,
          { bins: [{ index: info.index, state: "cas", label: "CAS" }], node: { index: info.index, at: 0 } },
          { threads: threadStatus(name, "CAS, no lock") }
        )
      );
      return steps;
    }
    steps.push(
      step(
        map,
        `${name}: bin ${info.index} is not empty -> synchronized on the head node`,
        { bins: [{ index: info.index, state: "locked", label: "locked" }], node: { index: info.index, at: 0 } },
        { threads: threadStatus(name, "holds the lock") }
      )
    );
    for (let at = 0; at < chain.length; at++) {
      const node = chain[at];
      const mark = { bins: [{ index: info.index, state: "locked", label: "locked" }], node: { index: info.index, at } };
      if (node.key === key) {
        steps.push(step(map, `${name}: walk bin ${info.index}: ${quote(node.key)} matches`, mark, { threads: threadStatus(name, "holds the lock") }));
        node.value = value;
        steps.push(
          step(
            map,
            `${name} replaces the value and releases the lock`,
            { bins: [{ index: info.index, state: "replace", label: "replaced" }], node: { index: info.index, at } },
            { threads: threadStatus(name, "released the lock") }
          )
        );
        return steps;
      }
      steps.push(
        step(
          map,
          `${name}: walk bin ${info.index}: ${quote(node.key)} ≠ ${quote(key)}`,
          mark,
          { threads: threadStatus(name, "holds the lock") }
        )
      );
    }
    chain.push({ key, value, hash: info.spread });
    map.size++;
    steps.push(
      step(
        map,
        `${name} chains a new node and releases the lock`,
        {
          bins: [{ index: info.index, state: "chain", label: "chained" }],
          node: { index: info.index, at: chain.length - 1 },
        },
        { threads: threadStatus(name, "released the lock") }
      )
    );
    return steps;
  }

  function parallelText(name, result) {
    if (result.kind === "cas") return `${name} CAS-inserts into empty bin ${result.index} (no lock).`;
    if (result.kind === "replace") return `${name} locks bin ${result.index} and replaces the value.`;
    return `${name} locks bin ${result.index} and chains a node.`;
  }

  function runBoth(map, first, second) {
    const steps = [];
    const ready = [];
    for (const actor of [first, second]) {
      if (actor.key === null || actor.value === null) steps.push(nullPut(map, actor.name, actor.key, actor.value));
      else ready.push(actor);
    }
    if (ready.length === 0) return steps;
    if (ready.length === 1) return steps.concat(putOne(map, ready[0].name, ready[0].key, ready[0].value));

    const left = ready[0];
    const right = ready[1];
    const leftInfo = describeKey(left.key, map.capacity);
    const rightInfo = describeKey(right.key, map.capacity);
    steps.push(
      step(map, `${left.name}: ${leftInfo.caption}`, lookup(leftInfo.index), { threads: { A: "hashing", B: "idle" } })
    );
    steps.push(
      step(
        map,
        `${right.name}: ${rightInfo.caption}`,
        {
          bins: [
            { index: leftInfo.index, state: "lookup", label: "A" },
            { index: rightInfo.index, state: "lookup", label: "B" },
          ],
        },
        { threads: { A: "hashed", B: "hashing" } }
      )
    );

    if (leftInfo.index !== rightInfo.index) {
      const leftResult = applyWrite(map, left.key, left.value);
      const rightResult = applyWrite(map, right.key, right.value);
      steps.push(
        step(
          map,
          `${parallelText(left.name, leftResult)} ${parallelText(right.name, rightResult)} Different buckets, so both proceed in parallel.`,
          {
            bins: [
              { index: leftResult.index, state: leftResult.kind === "cas" ? "cas" : "locked", label: leftResult.kind === "cas" ? "CAS" : "locked" },
              { index: rightResult.index, state: rightResult.kind === "cas" ? "cas" : "locked", label: rightResult.kind === "cas" ? "CAS" : "locked" },
            ],
            nodes: [
              { index: leftResult.index, at: leftResult.at },
              { index: rightResult.index, at: rightResult.at },
            ],
          },
          { threads: { A: leftResult.kind === "cas" ? "CAS, no lock" : "holds its own bin", B: rightResult.kind === "cas" ? "CAS, no lock" : "holds its own bin" } }
        )
      );
      return steps;
    }

    const index = leftInfo.index;
    if (map.buckets[index].length === 0) {
      steps.push(
        step(
          map,
          `Both threads target empty bin ${index}.`,
          { bins: [{ index, state: "lookup", label: "both" }] },
          { threads: { A: "CAS", B: "CAS" } }
        )
      );
      const winner = applyWrite(map, left.key, left.value);
      steps.push(
        step(
          map,
          `${left.name} wins the CAS on empty bin ${index} and inserts ${quote(left.key)} (no lock). ${right.name}'s CAS fails.`,
          { bins: [{ index, state: "cas", label: "CAS" }], node: { index, at: winner.at } },
          { threads: { A: "CAS, no lock", B: "CAS failed" } }
        )
      );
      const follower = applyWrite(map, right.key, right.value);
      const verb = follower.kind === "replace" ? "replaces the value" : "chains a node";
      steps.push(
        step(
          map,
          `${right.name} locks the head of bin ${index} and ${verb}.`,
          { bins: [{ index, state: "locked", label: "locked" }], node: { index, at: follower.at } },
          { threads: { A: "done", B: "holds the lock" } }
        )
      );
      return steps;
    }

    steps.push(
      step(
        map,
        `Both threads target bin ${index}, which is not empty. ${left.name} locks the head (synchronized). ${right.name} waits.`,
        { bins: [{ index, state: "locked", label: "locked by A; B waiting" }], node: { index, at: 0 } },
        { threads: { A: "holds the lock", B: "waiting" } }
      )
    );
    const firstWrite = applyWrite(map, left.key, left.value);
    const firstVerb = firstWrite.kind === "replace" ? "replaces the value" : "chains a node";
    steps.push(
      step(
        map,
        `${left.name} ${firstVerb} and releases the lock.`,
        { bins: [{ index, state: "chain", label: "A released" }], node: { index, at: firstWrite.at } },
        { threads: { A: "released the lock", B: "waiting" } }
      )
    );
    const secondWrite = applyWrite(map, right.key, right.value);
    const secondVerb = secondWrite.kind === "replace" ? "replaces the value" : "chains a node";
    steps.push(
      step(
        map,
        `${right.name} acquires the lock, ${secondVerb}, and releases it.`,
        { bins: [{ index, state: "chain", label: "B released" }], node: { index, at: secondWrite.at } },
        { threads: { A: "done", B: "released the lock" } }
      )
    );
    return steps;
  }

  function nodeText(node) {
    const key = node.key === null ? "null" : String(node.key);
    return `${key}=${node.value}`;
  }

  function highlightedNodes(highlight) {
    if (!highlight) return [];
    const nodes = [];
    if (highlight.node) nodes.push(highlight.node);
    if (highlight.nodes) nodes.push(...highlight.nodes);
    return nodes;
  }

  function renderBuckets(container, state, highlight) {
    const marks = new Map();
    (highlight && highlight.bins ? highlight.bins : []).forEach((bin) => marks.set(bin.index, bin));
    const current = highlightedNodes(highlight);
    container.replaceChildren();
    state.buckets.forEach((chain, index) => {
      const mark = marks.get(index);
      const bin = document.createElement("div");
      bin.className = "viz-bin";
      if (mark) bin.dataset.state = mark.state;
      const idx = document.createElement("span");
      idx.className = "viz-bin-index";
      idx.textContent = String(index);
      const flag = document.createElement("span");
      flag.className = "viz-flag";
      flag.textContent = mark ? mark.label : chain.length ? `${chain.length} nodes` : "empty";
      const list = document.createElement("ol");
      list.className = "viz-chain";
      if (!chain.length) {
        const blank = document.createElement("li");
        blank.className = "viz-node viz-node-empty";
        blank.textContent = "—";
        list.append(blank);
      }
      chain.forEach((node, at) => {
        const item = document.createElement("li");
        item.className = "viz-node";
        if (current.some((spot) => spot.index === index && spot.at === at)) item.dataset.on = "true";
        item.textContent = nodeText(node);
        list.append(item);
      });
      const spoken = [`bucket ${index}`, flag.textContent].concat(chain.map(nodeText));
      bin.setAttribute("aria-label", spoken.join(", "));
      bin.append(idx, list, flag);
      container.append(bin);
    });
  }

  function renderStats(container, state, mode) {
    const bits = [
      ["size", String(state.size)],
      ["capacity", String(state.capacity)],
    ];
    if (mode === "hashmap") bits.push(["threshold", `${state.threshold} (${state.capacity} × 0.75)`]);
    container.replaceChildren();
    bits.forEach(([name, value]) => {
      const item = document.createElement("span");
      item.className = "viz-stat";
      const label = document.createElement("span");
      label.textContent = name;
      const strong = document.createElement("strong");
      strong.textContent = value;
      item.append(label, strong);
      container.append(item);
    });
  }

  function renderStepList(list, steps, index) {
    list.replaceChildren();
    steps.forEach((item, at) => {
      const row = document.createElement("li");
      if (at === index) row.setAttribute("aria-current", "step");
      row.textContent = item.caption;
      list.append(row);
    });
  }

  function renderThreads(view, stepInfo) {
    if (!view.threadStatus) return;
    const threads = (stepInfo && stepInfo.threads) || {};
    view.threadStatus.A.textContent = threads.A || "idle";
    view.threadStatus.B.textContent = threads.B || "idle";
  }

  let fieldSeq = 0;
  function fieldId(prefix) {
    fieldSeq += 1;
    return `${prefix}-${fieldSeq}`;
  }

  function makePlayer(view) {
    let steps = [];
    let index = 0;
    let timer = 0;

    function stop() {
      if (timer) clearInterval(timer);
      timer = 0;
      view.play.setAttribute("aria-pressed", "false");
      view.play.textContent = "Play";
    }

    function show(at) {
      index = at;
      const current = steps[at] || null;
      view.caption.textContent = current ? current.caption : view.idleCaption;
      view.caption.classList.toggle("is-error", !!(current && current.error));
      const state = current ? current.state : view.model;
      renderBuckets(view.bins, state, current && current.highlight);
      renderStats(view.stats, state, view.mode);
      renderThreads(view, current);
      renderStepList(view.list, steps, current ? at : -1);
      view.prev.disabled = !current || at <= 0;
      view.next.disabled = !current || at >= steps.length - 1;
    }

    function setSteps(nextSteps) {
      stop();
      steps = nextSteps;
      show(0);
    }

    view.prev.addEventListener("click", () => {
      stop();
      if (index > 0) show(index - 1);
    });
    view.next.addEventListener("click", () => {
      stop();
      if (index < steps.length - 1) show(index + 1);
    });
    view.play.addEventListener("click", () => {
      if (timer) {
        stop();
        return;
      }
      if (!steps.length || index >= steps.length - 1) return;
      view.play.setAttribute("aria-pressed", "true");
      view.play.textContent = "Pause";
      timer = setInterval(() => {
        if (!view.root.isConnected || index >= steps.length - 1) {
          stop();
          return;
        }
        show(index + 1);
      }, 800);
    });

    view.prev.disabled = true;
    view.next.disabled = true;
    return { setSteps, show, stop };
  }

  function button(label, className) {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = label;
    if (className) control.className = className;
    return control;
  }

  function labelledInput(labelText, id, value) {
    const wrap = document.createElement("label");
    wrap.className = "viz-field";
    wrap.htmlFor = id;
    wrap.append(document.createTextNode(labelText));
    const input = document.createElement("input");
    input.id = id;
    input.type = "text";
    input.value = value;
    input.autocomplete = "off";
    input.spellcheck = false;
    wrap.append(input);
    return { wrap, input };
  }

  function paragraph(className, text) {
    const node = document.createElement("p");
    node.className = className;
    node.textContent = text;
    return node;
  }

  function mountHashMap(slot) {
    const model = createMap();
    const keyId = fieldId("hm-key");
    const valueId = fieldId("hm-value");
    const root = document.createElement("section");
    root.className = "viz viz-hashmap";
    root.setAttribute("aria-label", "HashMap visualizer");

    const key = labelledInput("Key", keyId, "Aa");
    const value = labelledInput("Value", valueId, "1");
    const put = button("Put", "viz-primary");
    put.type = "submit";
    const getBtn = button("Get");
    const removeBtn = button("Remove");
    const resetBtn = button("Reset");
    const form = document.createElement("form");
    form.className = "viz-form";
    const actions = document.createElement("div");
    actions.className = "viz-actions";
    actions.append(put, getBtn, removeBtn, resetBtn);
    form.append(key.wrap, value.wrap, actions);

    const presets = document.createElement("div");
    presets.className = "viz-presets";
    presets.append(paragraph("viz-preset-label", "Presets"));
    const nullState = { on: false };
    const nullNote = paragraph("viz-null-note", "Using the null key (hash 0, bucket 0).");
    nullNote.hidden = true;

    [
      ["Aa", "Aa", "1"],
      ["BB", "BB", "2"],
      ["kafka", "kafka", "k"],
    ].forEach(([label, presetKey, presetValue]) => {
      const preset = button(label);
      preset.addEventListener("click", () => {
        nullState.on = false;
        nullNote.hidden = true;
        key.input.value = presetKey;
        value.input.value = presetValue;
        key.input.focus();
      });
      presets.append(preset);
    });
    const nullBtn = button("null");
    nullBtn.setAttribute("aria-label", "Preset null key");
    nullBtn.setAttribute("aria-pressed", "false");
    nullBtn.addEventListener("click", () => {
      nullState.on = true;
      nullBtn.setAttribute("aria-pressed", "true");
      nullNote.hidden = false;
      key.input.value = "";
      value.input.value = "0";
      key.input.focus();
    });
    key.input.addEventListener("input", () => {
      nullState.on = false;
      nullBtn.setAttribute("aria-pressed", "false");
      nullNote.hidden = true;
    });
    presets.append(nullBtn);

    const bins = document.createElement("div");
    bins.className = "viz-bins";
    bins.tabIndex = 0;
    bins.setAttribute("aria-label", "Buckets");
    const stats = document.createElement("div");
    stats.className = "viz-stats";
    const prev = button("Previous");
    const next = button("Next");
    const play = button("Play");
    play.setAttribute("aria-pressed", "false");
    const controls = document.createElement("div");
    controls.className = "viz-actions";
    controls.append(prev, next, play);
    const caption = document.createElement("p");
    caption.className = "viz-caption";
    caption.setAttribute("role", "status");
    caption.setAttribute("aria-live", "polite");
    caption.setAttribute("aria-atomic", "true");
    const list = document.createElement("ol");
    list.className = "viz-steps";
    list.setAttribute("aria-label", "Steps");

    root.append(
      paragraph("viz-title", "HashMap"),
      stats,
      bins,
      paragraph("viz-hint", "Scroll the bucket row if it does not fit."),
      caption,
      controls,
      form,
      presets,
      nullNote,
      list,
      paragraph(
        "viz-notes",
        "A bin becomes a red-black tree at 8 entries only once the table has at least 64 buckets. Below 64 the map resizes instead. A tree turns back into a list at 6 entries."
      )
    );
    slot.replaceChildren(root);

    const view = {
      root,
      bins,
      stats,
      prev,
      next,
      play,
      caption,
      list,
      mode: "hashmap",
      model,
      idleCaption: "Put, get, or remove a key. Aa and BB share a hashCode.",
      threadStatus: null,
    };
    const player = makePlayer(view);
    renderBuckets(bins, model, null);
    renderStats(stats, model, "hashmap");
    caption.textContent = view.idleCaption;

    function readKey() {
      return nullState.on ? null : key.input.value;
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      player.setSteps(putEntry(model, readKey(), value.input.value));
    });
    getBtn.addEventListener("click", () => player.setSteps(getEntry(model, readKey())));
    removeBtn.addEventListener("click", () => player.setSteps(removeEntry(model, readKey())));
    resetBtn.addEventListener("click", () => {
      const fresh = createMap();
      model.capacity = fresh.capacity;
      model.threshold = fresh.threshold;
      model.size = fresh.size;
      model.buckets = fresh.buckets;
      nullState.on = false;
      nullBtn.setAttribute("aria-pressed", "false");
      nullNote.hidden = true;
      key.input.value = "Aa";
      value.input.value = "1";
      player.stop();
      player.setSteps([
        step(model, "Reset. Capacity 16, threshold 12 (16 × 0.75).", null),
      ]);
    });
  }

  function mountConcurrent(slot) {
    const model = createMap();
    const root = document.createElement("section");
    root.className = "viz viz-chm";
    root.setAttribute("aria-label", "ConcurrentHashMap visualizer");

    function threadBox(name) {
      const box = document.createElement("fieldset");
      box.className = "viz-thread";
      const legend = document.createElement("legend");
      legend.textContent = name;
      const key = labelledInput("Key", fieldId("chm-key"), name === "Thread A" ? "kafka" : "java");
      const value = labelledInput("Value", fieldId("chm-value"), name === "Thread A" ? "1" : "2");
      const put = button("Put", "viz-primary");
      const nullBtn = button("null");
      nullBtn.setAttribute("aria-label", `${name} null key`);
      nullBtn.setAttribute("aria-pressed", "false");
      const status = document.createElement("p");
      status.className = "viz-thread-status";
      const statusLabel = document.createElement("span");
      statusLabel.textContent = "Status";
      const statusValue = document.createElement("strong");
      statusValue.textContent = "idle";
      status.append(statusLabel, statusValue);
      const nullNote = paragraph("viz-null-note", "Using the null key.");
      nullNote.hidden = true;
      const nullState = { on: false };
      nullBtn.addEventListener("click", () => {
        nullState.on = true;
        nullBtn.setAttribute("aria-pressed", "true");
        nullNote.hidden = false;
        key.input.value = "";
      });
      key.input.addEventListener("input", () => {
        nullState.on = false;
        nullBtn.setAttribute("aria-pressed", "false");
        nullNote.hidden = true;
      });
      const row = document.createElement("div");
      row.className = "viz-actions";
      row.append(put, nullBtn);
      box.append(legend, key.wrap, value.wrap, row, nullNote, status);
      return { box, key: key.input, value: value.input, put, nullBtn, nullState, nullNote, statusValue };
    }

    const threadA = threadBox("Thread A");
    const threadB = threadBox("Thread B");
    const threads = document.createElement("div");
    threads.className = "viz-threads";
    threads.append(threadA.box, threadB.box);

    const scenarios = document.createElement("div");
    scenarios.className = "viz-presets";
    scenarios.append(paragraph("viz-preset-label", "Presets"));
    const different = button("Different buckets");
    const same = button("Same bucket");
    different.addEventListener("click", () => {
      fill(threadA, "kafka", "1");
      fill(threadB, "java", "2");
    });
    same.addEventListener("click", () => {
      fill(threadA, "BB", "2");
      fill(threadB, "CC", "3");
    });
    const run = button("Run both", "viz-primary");
    const resetBtn = button("Reset");
    scenarios.append(different, same, run, resetBtn);

    const bins = document.createElement("div");
    bins.className = "viz-bins";
    bins.tabIndex = 0;
    bins.setAttribute("aria-label", "Buckets");
    const stats = document.createElement("div");
    stats.className = "viz-stats";
    const prev = button("Previous");
    const next = button("Next");
    const play = button("Play");
    play.setAttribute("aria-pressed", "false");
    const controls = document.createElement("div");
    controls.className = "viz-actions";
    controls.append(prev, next, play);
    const caption = document.createElement("p");
    caption.className = "viz-caption";
    caption.setAttribute("role", "status");
    caption.setAttribute("aria-live", "polite");
    caption.setAttribute("aria-atomic", "true");
    const list = document.createElement("ol");
    list.className = "viz-steps";
    list.setAttribute("aria-label", "Steps");
    const notes = document.createElement("div");
    notes.className = "viz-notes";
    [
      "Java 7 used 16 Segment locks; Java 8+ removed segments and locks per bin.",
      "Hashtable and Collections.synchronizedMap use one lock for the whole map.",
      "get() takes no lock.",
      "Null keys and values throw NullPointerException.",
      "During a resize, buckets that have already been moved hold a forwarding node, and other threads help with the transfer. Resizing is not simulated here.",
    ].forEach((line) => notes.append(paragraph("", line)));

    root.append(
      paragraph("viz-title", "ConcurrentHashMap"),
      paragraph("viz-hint", "Put one key first, then use Same bucket and Run both to see the other thread wait."),
      stats,
      bins,
      paragraph("viz-hint", "Scroll the bucket row if it does not fit."),
      caption,
      controls,
      threads,
      scenarios,
      list,
      notes
    );
    slot.replaceChildren(root);

    function fill(thread, keyText, valueText) {
      thread.nullState.on = false;
      thread.nullBtn.setAttribute("aria-pressed", "false");
      thread.nullNote.hidden = true;
      thread.key.value = keyText;
      thread.value.value = valueText;
    }

    function read(thread) {
      return {
        name: thread.box.querySelector("legend").textContent,
        key: thread.nullState.on ? null : thread.key.value,
        value: thread.value.value,
      };
    }

    const view = {
      root,
      bins,
      stats,
      prev,
      next,
      play,
      caption,
      list,
      mode: "concurrent",
      model,
      idleCaption: "Run one thread, or both. Empty bins use CAS. A shared non-empty bin is locked.",
      threadStatus: { A: threadA.statusValue, B: threadB.statusValue },
    };
    const player = makePlayer(view);
    renderBuckets(bins, model, null);
    renderStats(stats, model, "concurrent");
    caption.textContent = view.idleCaption;

    threadA.put.addEventListener("click", () => {
      const actor = read(threadA);
      player.setSteps(putOne(model, actor.name, actor.key, actor.value));
    });
    threadB.put.addEventListener("click", () => {
      const actor = read(threadB);
      player.setSteps(putOne(model, actor.name, actor.key, actor.value));
    });
    run.addEventListener("click", () => player.setSteps(runBoth(model, read(threadA), read(threadB))));
    resetBtn.addEventListener("click", () => {
      const fresh = createMap();
      model.capacity = fresh.capacity;
      model.threshold = fresh.threshold;
      model.size = fresh.size;
      model.buckets = fresh.buckets;
      fill(threadA, "kafka", "1");
      fill(threadB, "java", "2");
      player.stop();
      player.setSteps([step(model, "Reset. Empty table, capacity 16.", null, { threads: { A: "idle", B: "idle" } })]);
    });
  }

  function mount(container) {
    container.querySelectorAll(".viz-mount").forEach((slot) => {
      if (slot.dataset.ready === "1") return;
      const kind = slot.getAttribute("data-visualizer");
      if (kind !== "hashmap" && kind !== "concurrenthashmap") return;
      slot.dataset.ready = "1";
      if (kind === "hashmap") mountHashMap(slot);
      else mountConcurrent(slot);
    });
  }

  if (globalObject && globalObject.document) {
    globalObject.InterviewVisualizers = { mount };
  }

  if (typeof module !== "undefined" && module.exports && typeof document === "undefined") {
    module.exports = {
      javaStringHashCode,
      describeKey,
      createMap,
      putEntry,
      getEntry,
      removeEntry,
      putOne,
      runBoth,
    };
  }
})(typeof window !== "undefined" ? window : globalThis);
