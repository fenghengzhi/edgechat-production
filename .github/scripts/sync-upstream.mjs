import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const UPSTREAM = "aozorae/Edgechat";
const UPSTREAM_REF = "refs/remotes/edgechat-upstream/release";
const DEPLOY_WORKFLOW = "deploy-worker.yml";

async function runGit(args) {
	const { stdout } = await exec("git", args, {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		timeout: 120_000,
	});
	return stdout.trim();
}

async function githubRequest(path, body) {
	const response = await fetch(`https://api.github.com${path}`, {
		method: body ? "POST" : "GET",
		headers: {
			Authorization: `Bearer ${process.env.GH_TOKEN}`,
			Accept: "application/vnd.github+json",
			"Content-Type": "application/json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		throw new Error(`GitHub API ${path}: HTTP ${response.status}`);
	}
	return response.status === 204 ? undefined : response.json();
}

export function findUpdateCommit(log) {
	// 用 Git 的 trailer 解析器只读取提交尾部参数，避免正文提到标记就触发发布。
	const fields = log.split("\0");
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const kind = fields[index + 1]
			.trim()
			.split("\n")
			.find((value) => value === "stable" || value === "security");
		if (kind) return { commit: fields[index].trim(), kind };
	}
	return undefined;
}

export async function syncUpstream({
	repository,
	branch,
	hasSyncToken = false,
	git = runGit,
	request = githubRequest,
	wait = delay,
}) {
	if (repository.toLowerCase() === UPSTREAM.toLowerCase()) {
		console.log("上游主仓无需同步自身。");
		return { updated: false, dispatched: false };
	}
	const upstream = await request(`/repos/${UPSTREAM}`);
	await git(["fetch", "--no-tags", "origin", `refs/heads/${branch}`]);
	await git(["checkout", "--detach", "FETCH_HEAD"]);
	const original = await git(["rev-parse", "HEAD"]);
	await git([
		"fetch",
		"--no-tags",
		`https://github.com/${UPSTREAM}.git`,
		`+refs/heads/${upstream.default_branch}:${UPSTREAM_REF}`,
	]);
	const target = findUpdateCommit(
		await git([
			"log",
			"--first-parent",
			"--format=%H%x00%(trailers:key=EdgeChat-Update,valueonly)%x00",
			UPSTREAM_REF,
		]),
	);
	if (!target) {
		console.log("上游没有 stable/security 发布标记，保持当前版本。");
		return { updated: false, dispatched: false };
	}

	let base;
	try {
		base = await git(["merge-base", "--all", original, target.commit]);
	} catch (error) {
		if (error.code !== 1) throw error;
		throw new Error("当前分支与上游发布没有共同历史，已停止同步。");
	}
	if (base.includes("\n")) throw new Error("存在多个合并基点，请手动确认重放范围。");
	const hasForkMerges = Boolean(await git(["rev-list", "--merges", "-1", `${base}..${original}`]));
	// An older sync may have brought this release in as the second parent.
	let needsRebase = base !== target.commit;
	if (!needsRebase && hasForkMerges) {
		const firstParents = await git(["rev-list", "--first-parent", original]);
		needsRebase = !firstParents.split("\n").includes(target.commit);
	}
	let updated = false;
	if (needsRebase) {
		await git(["config", "user.name", "github-actions[bot]"]);
		await git([
			"config",
			"user.email",
			"41898282+github-actions[bot]@users.noreply.github.com",
		]);
		// Flatten old sync merges only if their conflict resolutions survive.
		const expectedTree = hasForkMerges ? await git(["merge-tree", "--write-tree", original, target.commit]) : null;
		await git([
			"rebase",
			"--no-rebase-merges",
			"--no-update-refs",
			"--reapply-cherry-picks",
			"--empty=keep",
			"--onto",
			target.commit,
			base,
		]);
		if (expectedTree && expectedTree !== (await git(["rev-parse", "HEAD^{tree}"]))) {
			throw new Error("变基结果未保留原合并中的修改，已停止推送，请手动处理。");
		}
		const workflowsChanged = await git([
			"diff",
			"--name-only",
			original,
			"HEAD",
			"--",
			".github/workflows",
		]);
		if (workflowsChanged && !hasSyncToken) {
			throw new Error(
				"更新包含 Actions 文件，请配置具有 Contents/Workflows 写权限的 EDGECHAT_SYNC_TOKEN 后重试。",
			);
		}
		const ref = `refs/heads/${branch}`;
		await git(["push", `--force-with-lease=${ref}:${original}`, "origin", `HEAD:${ref}`]);
		updated = true;
	}

	const commit = await git(["rev-parse", "HEAD"]);
	const workflowPath = `/repos/${repository}/actions/workflows/${DEPLOY_WORKFLOW}`;
	const runsPath = `${workflowPath}/runs?branch=${encodeURIComponent(branch)}&head_sha=${commit}&per_page=100`;
	// A PAT push can trigger deployment before the run appears in the API.
	const retries = updated && hasSyncToken ? 4 : 0;
	for (let attempt = 0; attempt <= retries; attempt++) {
		if (attempt) await wait(5000);
		const { workflow_runs: runs } = await request(runsPath);
		if (runs.some(run => run.conclusion === "success" || run.status !== "completed")) {
			console.log(`${target.kind}: ${commit} 已部署或正在部署，无需重复派发。`);
			return { updated, dispatched: false, commit };
		}
		if (runs.length) break;
	}
	// GITHUB_TOKEN 的 push 不会触发 Actions；dispatch 是官方允许的例外。
	// 即使上次推送后派发/部署失败，下次检查也会对当前 SHA 重新派发。
	await request(`${workflowPath}/dispatches`, { ref: branch });
	console.log(`${target.kind}: ${commit} 已同步，已派发 Deploy Worker。`);
	return { updated, dispatched: true, commit };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	syncUpstream({
		repository: process.env.GITHUB_REPOSITORY,
		branch: process.env.EDGECHAT_DEFAULT_BRANCH,
		hasSyncToken: process.env.EDGECHAT_HAS_SYNC_TOKEN === "true",
	}).catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
