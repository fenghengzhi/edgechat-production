import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	findUpdateCommit,
	syncUpstream,
} from "../.github/scripts/sync-upstream.mjs";

function fixture(t, { customized = false, conflict = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "edgechat-sync-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const upstream = join(root, "upstream");
	const origin = join(root, "fork.git");
	const checkout = join(root, "checkout");
	function command(cwd, args) {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	}
	command(root, ["init", "--initial-branch=main", upstream]);
	command(upstream, ["config", "user.name", "Test"]);
	command(upstream, ["config", "user.email", "test@example.com"]);
	function commit(message, name, content = message) {
		mkdirSync(join(upstream, name, ".."), { recursive: true });
		writeFileSync(join(upstream, name), content);
		command(upstream, ["add", name]);
		command(upstream, ["commit", "-m", message]);
		return command(upstream, ["rev-parse", "HEAD"]);
	}
	const base = commit("Initial", "package.json", '{"version":"1.0.0"}\n');
	command(root, ["clone", "--bare", upstream, origin]);
	command(root, ["clone", origin, checkout]);
	if (customized || conflict) {
		command(checkout, ["config", "user.name", "Fork owner"]);
		command(checkout, ["config", "user.email", "owner@example.com"]);
		const name = conflict ? "package.json" : "custom.txt";
		writeFileSync(join(checkout, name), "Fork customization\n");
		command(checkout, ["add", name]);
		command(checkout, ["commit", "-m", "Customize fork"]);
		command(checkout, ["push", "origin", "main"]);
	}
	const requests = [];
	let runs = [];
	let runsAfterWait;
	let failDispatch = false;
	let rejectPush = false;
	return {
		base,
		commit,
		requests,
		upstream,
		setRuns(value) {
			runs = value;
		},
		setRunsAfterWait(value) {
			runsAfterWait = value;
		},
		failDispatch(value) {
			failDispatch = value;
		},
		rejectPush() {
			rejectPush = true;
		},
		originHead: () => command(origin, ["rev-parse", "main"]),
		read: (name) => readFileSync(join(checkout, name), "utf8"),
		git: (args) => command(checkout, args),
		async sync(hasSyncToken = false, beforePush) {
			return syncUpstream({
				repository: "example/Edgechat",
				branch: "main",
				hasSyncToken,
				wait: async () => {
					if (runsAfterWait) runs = runsAfterWait;
				},
				git: async (args) => {
					if (rejectPush && args[0] === "push")
						throw new Error("Branch protection rejected push");
					if (args[0] === "push") beforePush?.(args);
					const localArgs = args.map((arg) =>
						arg === "https://github.com/aozorae/Edgechat.git" ? upstream : arg,
					);
					try {
						return command(checkout, localArgs);
					} catch (error) {
						// execFile 的异步错误用 code，同步 Git 测试用 status。
						error.code = error.status;
						throw error;
					}
				},
				request: async (path, body) => {
					requests.push({ path, body });
					if (path === "/repos/aozorae/Edgechat")
						return { default_branch: "main" };
					if (path.includes("/runs?")) return { workflow_runs: runs };
					assert.match(
						path,
						/\/actions\/workflows\/deploy-worker.yml\/dispatches$/,
					);
					assert.deepEqual(body, { ref: "main" });
					if (failDispatch) throw new Error("Dispatch failed");
				},
			});
		},
	};
}

test("上游主仓不同步自身也不派发部署", async () => {
	const result = await syncUpstream({
		repository: "aozorae/Edgechat",
		branch: "master",
		git: () => assert.fail("No git on upstream"),
		request: () => assert.fail("No API on upstream"),
	});
	assert.deepEqual(result, { updated: false, dispatched: false });
});

test("没有发布 trailer 的提交不会自动同步", async (t) => {
	const f = fixture(t);
	f.commit("Mention EdgeChat-Update: stable in subject", "development.txt");
	f.commit("Unknown\n\nEdgeChat-Update: beta", "beta.txt");
	assert.deepEqual(await f.sync(), { updated: false, dispatched: false });
	assert.equal(f.originHead(), f.base);
	assert.equal(f.requests.length, 1);
});

test("没有定制时直接快进到 stable，保留发布之前的变更", async (t) => {
	const f = fixture(t);
	f.commit("Earlier feature", "feature.txt");
	const release = f.commit(
		"Release\n\nEdgeChat-Update: stable",
		"package.json",
		'{"version":"1.1.0"}\n',
	);
	f.commit("Unreleased development", "development.txt");
	const result = await f.sync();
	assert.deepEqual(result, {
		updated: true,
		dispatched: true,
		commit: f.originHead(),
	});
	assert.equal(result.commit, release);
	assert.equal(f.read("feature.txt"), "Earlier feature");
	assert.equal(JSON.parse(f.read("package.json")).version, "1.1.0");
	assert.throws(() => f.read("development.txt"), { code: "ENOENT" });
	assert.ok(
		f.requests.some(({ path }) => path.includes(`head_sha=${result.commit}`)),
	);
});

test("连续发布后定制提交都位于最新标记上方，重复检查保留当前 SHA", async (t) => {
	const f = fixture(t, { customized: true });
	f.git(["mv", "custom.txt", "theme.txt"]);
	f.git(["commit", "-m", "Rename customization"]);
	f.git(["push", "origin", "main"]);
	const stable = f.commit("Stable\n\nEdgeChat-Update: stable", "stable.txt");
	f.commit("Feature in development", "later-feature.txt");
	const first = await f.sync();
	assert.equal(first.updated, true);
	assert.equal(first.dispatched, true);
	assert.equal(f.git(["rev-parse", "HEAD~2"]), stable);
	assert.throws(() => f.read("later-feature.txt"), { code: "ENOENT" });

	const security = f.commit("Fix\n\nEdgeChat-Update: security", "security.txt");
	f.commit("Work after release", "draft.txt");
	const result = await f.sync();
	assert.equal(result.updated, true);
	assert.equal(result.dispatched, true);
	assert.equal(f.git(["rev-parse", "HEAD~2"]), security);
	assert.equal(f.git(["log", "--format=%s (%an)", `${security}..HEAD`]),
		"Rename customization (Fork owner)\nCustomize fork (Fork owner)");
	assert.notEqual(result.commit, first.commit);
	assert.equal(f.read("theme.txt"), "Fork customization\n");
	assert.equal(f.read("later-feature.txt"), "Feature in development");
	assert.throws(() => f.read("draft.txt"), { code: "ENOENT" });
	assert.equal(f.originHead(), result.commit);
	f.setRuns([{ status: "completed", conclusion: "success" }]);
	assert.deepEqual(await f.sync(), { updated: false, dispatched: false, commit: result.commit });
});

test("变基冲突时保留远端版本并跳过部署", async (t) => {
	const f = fixture(t, { conflict: true });
	const before = f.originHead();
	f.commit(
		"Fix\n\nEdgeChat-Update: security",
		"package.json",
		'{"version":"1.0.1"}\n',
	);
	await assert.rejects(f.sync());
	assert.equal(f.originHead(), before);
	assert.equal(f.requests.length, 1);
});

test("将第二父系引入的旧同步合并改为线性历史并保留整个文件树", async (t) => {
	const f = fixture(t, { customized: true });
	const release = f.commit("Release\n\nEdgeChat-Update: stable", "release.txt");
	f.git(["fetch", f.upstream, "main"]);
	f.git(["merge", "--no-ff", "-m", "chore: sync upstream stable update [skip ci]", release]);
	f.git(["mv", "custom.txt", "theme.txt"]);
	f.git(["commit", "-m", "Rename customization"]);
	f.git(["push", "origin", "main"]);
	const previousTree = f.git(["rev-parse", "HEAD^{tree}"]);

	assert.equal((await f.sync()).updated, true);
	assert.equal(f.git(["rev-parse", "HEAD~2"]), release);
	assert.equal(f.git(["rev-parse", "HEAD^{tree}"]), previousTree);
	assert.equal(f.originHead(), f.git(["rev-parse", "HEAD"]));
});

test("旧合并里单独保存的手工调整会在重放中消失时拒绝改写远端", async (t) => {
	const f = fixture(t, { customized: true });
	const release = f.commit("Release\n\nEdgeChat-Update: stable", "release.txt");
	f.git(["fetch", f.upstream, "main"]);
	f.git(["merge", "--no-ff", "--no-commit", release]);
	f.git(["mv", "release.txt", "production-release.txt"]);
	f.git(["commit", "-m", "chore: sync upstream stable update [skip ci]"]);
	f.git(["push", "origin", "main"]);
	const before = f.originHead();
	await assert.rejects(f.sync());
	assert.equal(f.originHead(), before);
	assert.equal(f.requests.length, 1);
});

test("远端与 tracking ref 在变基后同时前移，精确 lease 仍拒绝推送", async (t) => {
	const f = fixture(t, { customized: true });
	f.git(["commit", "--allow-empty", "-m", "Concurrent fork change"]);
	const concurrent = f.git(["rev-parse", "HEAD"]);
	f.commit("Release\n\nEdgeChat-Update: stable", "release.txt");
	await assert.rejects(f.sync(true, () => {
		f.git(["push", "origin", `${concurrent}:refs/heads/main`]);
		assert.equal(f.git(["rev-parse", "refs/remotes/origin/main"]), concurrent);
	}));
	assert.equal(f.originHead(), concurrent);
	assert.equal(f.requests.length, 1);
});

test("没有共同历史时保留原远端分支", async (t) => {
	const f = fixture(t, { customized: true });
	f.git(["switch", "--orphan", "replacement"]);
	f.git(["commit", "--allow-empty", "-m", "Independent history"]);
	f.git(["push", "--force-with-lease", "origin", "HEAD:refs/heads/main"]);
	const before = f.originHead();
	f.commit("Release\n\nEdgeChat-Update: stable", "release.txt");
	await assert.rejects(f.sync());
	assert.equal(f.originHead(), before);
	assert.equal(f.requests.length, 1);
});

test("分支保护拒绝推送时不派发部署", async (t) => {
	const f = fixture(t);
	f.commit("Release\n\nEdgeChat-Update: stable", "release.txt");
	f.rejectPush();
	await assert.rejects(f.sync(), /Branch protection/);
	assert.equal(f.originHead(), f.base);
	assert.equal(f.requests.length, 1);
});

test("工作流更新必须显式提供同步令牌，未配置时远端保持原样", async (t) => {
	const f = fixture(t);
	f.commit(
		"CI update\n\nEdgeChat-Update: stable",
		".github/workflows/example.yml",
	);
	await assert.rejects(f.sync(), /EDGECHAT_SYNC_TOKEN/);
	assert.equal(f.originHead(), f.base);
	assert.equal(f.requests.length, 1);
	assert.equal((await f.sync(true)).dispatched, true);
});

test("推送后派发失败，下次检查对当前 SHA 补派部署", async (t) => {
	const f = fixture(t);
	f.commit("Fix\n\nEdgeChat-Update: security", "fix.txt");
	f.failDispatch(true);
	await assert.rejects(f.sync(), /Dispatch failed/);
	const release = f.originHead();
	f.failDispatch(false);
	assert.deepEqual(await f.sync(), {
		updated: false,
		dispatched: true,
		commit: release,
	});
	f.setRuns([{ status: "completed", conclusion: "failure" }]);
	assert.equal((await f.sync()).dispatched, true);
});

test("当前 SHA 已部署或部署中时不重复派发", async (t) => {
	const f = fixture(t);
	f.commit("Release\n\nEdgeChat-Update: stable", "release.txt");
	await f.sync();
	const release = f.originHead();
	for (const run of [
		{ status: "completed", conclusion: "success" },
		{ status: "queued", conclusion: null },
		{ status: "in_progress", conclusion: null },
	]) {
		f.requests.length = 0;
		f.setRuns([run]);
		assert.deepEqual(await f.sync(), {
			updated: false,
			dispatched: false,
			commit: release,
		});
		assert.equal(f.requests.length, 2);
	}
});

test("PAT 推送后稍迟登记的部署运行会阻止重复派发", async (t) => {
	const f = fixture(t, { customized: true });
	f.commit("Stable\n\nEdgeChat-Update: stable", "release.txt");
	f.setRunsAfterWait([{ status: "queued", conclusion: null }]);
	const result = await f.sync(true);
	assert.equal(result.updated, true);
	assert.equal(result.dispatched, false);
	assert.ok(f.requests.filter(({ path }) => path.includes(`head_sha=${result.commit}`)).length >= 2);
	assert.ok(f.requests.every(({ body }) => !body));
});

test("标记选择仅接受两个约定值并选择最新提交", () => {
	assert.equal(findUpdateCommit(""), undefined);
	assert.deepEqual(
		findUpdateCommit("new\0beta\0\nsecurity\0security\n\0\nstable\0stable\n\0"),
		{ commit: "security", kind: "security" },
	);
});

test("每天两次检查，机器人推送后显式 dispatch，检查阶段不读取云凭据", () => {
	const workflow = readFileSync(
		new URL("../.github/workflows/sync-upstream.yml", import.meta.url),
		"utf8",
	);
	assert.match(workflow, /cron: "17 1,13 \* \* \*"/);
	assert.match(workflow, /workflow_dispatch:/);
	assert.match(workflow, /contents: write/);
	assert.match(workflow, /actions: write/);
	assert.match(workflow, /fetch-depth: 0/);
	assert.match(
		workflow,
		/ref: \$\{\{ github.event.repository.default_branch \}\}/,
	);
	assert.match(workflow, /cancel-in-progress: false/);
	assert.match(workflow, /run: node .github\/scripts\/sync-upstream.mjs/);
	assert.doesNotMatch(workflow, /CLOUDFLARE|pull_request|push:/);
	const script = readFileSync(
		new URL("../.github/scripts/sync-upstream.mjs", import.meta.url),
		"utf8",
	);
	assert.doesNotMatch(script, /["']--force["']/);
	assert.match(
		script,
		/request\(`\$\{workflowPath\}\/dispatches`, \{ ref: branch \}\)/,
	);
});
