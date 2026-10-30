'use strict';

/**
 * Task goals - a player-issued task must give the ACTION BRAIN a DSH goal, not just a queue entry.
 *
 * Why this exists (operator review, 2026-10-29): `!chop 2`, `!mine dirt 5` and language-brain
 * dispatches all ended at `brain.enqueue` - a Node-local task with no harness goal. Without a
 * goal the action brain has nothing to keep working on, so there is no goal round driver, no
 * continuation, and no place for a screenshot "steer" to land. The player asked for work and
 * the decision brain was never told.
 *
 * The goal does NOT re-run the work: the deterministic skill already owns execution (that is
 * the capability-first policy). The goal makes the action brain the supervisor/owner of the
 * outcome: observe the result, judge it against the player's request, correct or report.
 *
 * Guard rails:
 *   - one goal at a time: an active goal means "join it", never stack a second one;
 *   - identical command text inside `dedupeMs` is not given a second goal;
 *   - `maxGoalRounds` is capped by config (default 3) so a trivial `!mine dirt 1` cannot burn
 *     an unbounded number of model rounds;
 *   - nothing here throws into the command path: a failed goal creation is logged and the
 *     task still runs.
 */

const DEFAULTS = Object.freeze({
  enabled: true,
  purpose: 'execute',
  maxGoalRounds: 3,
  dedupeMs: 10_000
});

class TaskGoalInjection {
  /**
   * @param {object} deps { bridge, cfg, now, log }
   */
  constructor(deps = {}) {
    this.bridge = deps.bridge || null;
    this.cfg = { ...DEFAULTS, ...(deps.cfg || {}) };
    this.now = deps.now || (() => Date.now());
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    /** Live self-defense status provider; the goal text must explain reflex preemption. */
    this.selfDefense = typeof deps.selfDefense === 'function' ? deps.selfDefense : null;
    /**
     * The escalation ledger is goal-scoped. Without a goal-end event from DSH, the next
     * goal creation is the safe boundary: a previous failure cannot gate a fresh goal.
     */
    this.onNewGoal = typeof deps.onNewGoal === 'function' ? deps.onNewGoal : null;
    this.recent = new Map();
    this.lastGoal = null;
    this.lastSkip = null;
    this.created = 0;
    this.skipped = 0;
  }

  /** Active goal on the bound action-brain conversation, or null. */
  async activeGoal() {
    if (!this.bridge || typeof this.bridge.goalOf !== 'function') return null;
    let agentId = null;
    try {
      agentId = typeof this.bridge.boundAgentId === 'function' ? await this.bridge.boundAgentId() : null;
    } catch (err) {
      return null;
    }
    if (!agentId) return null;
    try {
      const goal = await this.bridge.goalOf(agentId);
      if (goal && goal.id && goal.phase === 'active') return { agentId, goal };
    } catch (err) {
      return null;
    }
    return null;
  }

  /**
   * Give the action brain a goal for this player-issued task.
   *
   * @param {object} input { command, taskName, source, objective? }
   * @returns {Promise<{ok:boolean, reason:string, goalId?:string}>}
   */
  async maybeCreate(input = {}) {
    const command = String(input.command || '').trim();
    if (!this.cfg.enabled) return this.skip('disabled', command);
    if (!command) return this.skip('no-command', command);
    if (!this.bridge || typeof this.bridge.createGoal !== 'function') {
      return this.skip('no-bridge', command);
    }
    const seenAt = this.recent.get(command);
    if (seenAt !== undefined && this.now() - seenAt < this.cfg.dedupeMs) {
      return this.skip('duplicate-within-window', command);
    }
    const active = await this.activeGoal();
    if (active) {
      this.recent.set(command, this.now());
      return this.skip('goal-active', command, { goalId: active.goal.id });
    }
    this.recent.set(command, this.now());
    if (this.recent.size > 100) this.recent.delete(this.recent.keys().next().value);
    if (this.onNewGoal) {
      try {
        this.onNewGoal();
      } catch (err) {
        this.log.warn(`failure-escalation reset failed: ${err.message}`);
      }
    }

    const text = input.objective
      ? String(input.objective)
      : [
          `玩家下发任务：${command}`,
          input.source ? `来源：${input.source}` : null,
          input.taskName ? `Node 侧已交给确定性技能执行（${input.taskName}），不要重复它的动作。` : 'Node 侧已排队执行，不要重复它的动作。',
          '你的职责是目标驱动地监督这次任务：',
          '1) 用 mc_state/mc_observe 看真实状态与结果（不要只看任务回执）；',
          '2) 非 minecraft: 物品/机制在首次尝试前先 lookup_mod_content 查"怎么放置/使用"；失败按类别处理',
          '   （回执带 class/requires）：transient→重观察后重试一次；precondition→修前置',
          '   （取物/合成/换工具），不要加重试次数；knowledge/unverified→**不要重复同一坐标**，先',
          '   lookup_mod_content 查模组机制，资料解决不了就 mc_ask_player 问玩家（等待回答期间身体动作',
          '   会被 Node 拒绝），然后带新信息经命令通道重试；capability→换输入层，表达不了才提议代码生成；',
          '   permission→停或问，绝不重试。**同一签名第三次盲试会被 Node 拒绝**。',
          '3) 升级是按动作的，不是按任务的：只有失败的那个动作换渠道；移动、观察、其他命令仍走能力优先',
          '   （例如锄地换了键鼠，走去下一片田仍用 goto）。动作成功后该签名清零，下次同类动作重新从命令通道开始。',
          '4) 换输入层亲自做（mc_step 一次一个）："key forward down/up"、"hold attack 600"、"tap inventory"、',
          '   "look 180 0"、"menu"、"click 10 0 pickup"、"close"、"shot 768"；输入步之间核对坐标与 screen。',
          '   模组键位先用 mc_keybinds 查稳定 ID（如 immersive_aircraft:dismount），一次性用 "tap <id>"，',
          '   按住用 "hold <id> ms" / "key <id> down|up"；raw R/键码不接受，没有对应 ID 时**直接说明限制**，',
          '   不要让玩家猜或代按（这不是禁止求助：机制不明时应该用 mc_ask_player 提一个具体问题）。',
          '5) **ms 级连续控制（驾驶/骑乘载具 mounted=true、行进中转向、动态瞄准）不要用原子 mc_step 键鼠驱动**：',
          '   每次调用隔一个会话回合，输入到达即过期，首次失败可能不可逆（载具坠毁/位移），之后写脚本也救不回。',
          '   首次尝试就用已晋升 code-skill，没有就立即提议代码生成（仍需人工批准），脚本在 Node 内以',
          '   ctx.state() + ctx.key/ctx.hold/ctx.tap + ctx.wait(ms) 跑实时闭环。等待批准期间保持载具安全（悬停/下机）。',
          '6) 结束时如实报告：做了什么、结果如何、还有什么没完成。',
          '不要把 Node 的失败回执当成成功（ok 但世界无效果 = unverified，不是成功），没有结构化证据不得宣称完成。'
        ].filter(Boolean).join('\n');

    /**
     * The reflex is a Node fast-loop action, not the model's. Say so in every goal so a task
     * that is preempted by combat is not misread as the action brain's own doing (operator
     * finding 2026-10-31). State still carries the full structured status.
     */
    const objectiveText = [text, this._selfDefenseLine()].filter(Boolean).join('\n');

    let agentId = null;
    try {
      agentId = typeof this.bridge.boundAgentId === 'function' ? await this.bridge.boundAgentId() : null;
    } catch (err) {
      agentId = null;
    }
    const res = await this.bridge.createGoal({
      agentId: agentId || undefined,
      goal: objectiveText,
      purpose: this.cfg.purpose,
      maxGoalRounds: this.cfg.maxGoalRounds,
      replace: false
    });
    if (!res || res.ok !== true || !res.goal || !res.goal.id) {
      const reason = (res && (res.reason || res.error)) || 'goal-create-failed';
      this.log.warn(`task goal not created for "${command}": ${reason}`);
      this.lastSkip = { reason, command, at: this.now() };
      this.skipped += 1;
      return { ok: false, reason };
    }
    this.created += 1;
    this.lastGoal = {
      id: res.goal.id,
      command,
      source: input.source || null,
      taskName: input.taskName || null,
      at: this.now()
    };
    this.log.info(`task goal injected for "${command}": ${res.goal.id}`);
    return { ok: true, reason: 'created', goalId: res.goal.id };
  }

  /**
   * Give the action brain a goal for an `@` natural-language request.
   *
   * Why (2026-10-29 operator review): the `@` channel forwards the line to the action brain
   * as a **message**, not a goal. A message is one turn; a task that needs several rounds
   * (or a repair after a failed step) simply stops, and a screenshot steer has no active
   * goal to land in. The original text is still forwarded verbatim (A02); this method only
   * adds the durable goal that owns the outcome.
   *
   * Unlike `!` tasks, nothing in Node executes the request, so the goal text tells the brain
   * to act (capability-first) and to answer chat-only lines rather than pretending to work.
   *
   * @param {object} input { text, speaker?, source? }
   * @returns {Promise<{ok:boolean, reason:string, goalId?:string}>}
   */
  async maybeCreateDialogue(input = {}) {
    const text = String(input.text || '').trim();
    if (!text) return this.skip('no-command', text);
    const objective = [
      `玩家通过 @ 自然语言向动作脑请求（原文已作为消息投递）：${JSON.stringify(text)}`,
      input.speaker ? `说话人：${input.speaker}` : null,
      input.source ? `来源：${input.source}` : null,
      '这条请求现在有一个跨轮 goal：把请求真正做完，而不是只回一句话。',
      '- 如果是聊天/问答：用 mc_say 简短回答，然后 update_goal complete。',
      '- 如果是动手任务：按能力优先执行（code-skill → 命令表 → 输入层 → 提议代码生成）；',
      '  每步用 mc_state/mc_observe 核对真实结果，不要只信回执。',
      '- 失败按类别处理：非 minecraft: 物品/机制首次尝试前先 lookup_mod_content；knowledge/unverified（回执会标注）不要重复同一坐标，先 lookup_mod_content 查机制，',
      '  资料解决不了就 mc_ask_player 问玩家，再带新信息经命令通道重试；其余类别按回执 requires 处理；',
      '  同一签名第三次盲试会被 Node 拒绝。升级按动作不按任务：只有失败动作换渠道，移动仍用 goto。',
      '- 换键鼠输入层（key/hold/tap/look/menu/click/close/shot）时：模组键位先用 mc_keybinds 查稳定 ID，',
      '  一次性用 tap、按住用 hold/key down；raw R/键码不接受；没有对应 ID 时直接说明限制。',
      '- **ms 级连续控制（驾驶载具 mounted=true 等）不要用原子键鼠**：首次就提议 code-skill 脚本',
      '  （ctx.key/ctx.hold + ctx.wait 实时闭环，需人工批准）；等待期间保持载具安全，不要"试一下"。',
      '- 结束时如实报告：做了什么、结果如何、还缺什么；ok 但世界无效果不算成功，没有结构化证据不得宣称完成。'
    ].filter(Boolean).join('\n');
    return this.maybeCreate({ command: text, source: input.source || 'dialogue', objective });
  }

  skip(reason, command, extra = {}) {
    this.skipped += 1;
    this.lastSkip = { reason, command, at: this.now(), ...extra };
    this.log.debug(`task goal skipped for "${command}": ${reason}`);
    return { ok: false, reason, ...extra };
  }

  /** One short reflex note appended to the goal objective; empty when the provider is absent off. */
  _selfDefenseLine() {
    if (!this.selfDefense) return null;
    try {
      const status = this.selfDefense();
      if (!status || status.enabled !== true) return null;
      return (
        `注意：自卫反射已开启（autoFight），附近敌意生物出现或受伤时 Node 会自行先手攻击，` +
        `并可能抢占当前任务；这些攻击是反射，不是你的指令。范围 XZ ${status.engageRadiusXZ} / ` +
        `Y ±${status.engageRadiusY}，受伤阈值 ${status.engageHealthThreshold}。`
      );
    } catch (err) {
      this.log.debug(`self-defense note failed: ${err.message}`);
      return null;
    }
  }

  status() {
    return {
      enabled: this.cfg.enabled,
      purpose: this.cfg.purpose,
      maxGoalRounds: this.cfg.maxGoalRounds,
      created: this.created,
      skipped: this.skipped,
      lastGoal: this.lastGoal,
      lastSkip: this.lastSkip
    };
  }
}

module.exports = { TaskGoalInjection, DEFAULTS };
