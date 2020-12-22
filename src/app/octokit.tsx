import * as localforage from "localforage";

import { Octokit } from "@octokit/rest";
import { OctokitResponse } from "@octokit/types/dist-types/OctokitResponse";
import {
  GitGetTreeResponseData,
  GitCreateTreeResponseData,
  ReposGetContentResponseData,
} from "@octokit/types/dist-types/generated/Endpoints";

import { okAsync, errAsync, ResultAsync } from "neverthrow";

import { EntryFile, WrappedError } from "./types";
import { Repo, Repos, MultiRepoFile } from "./repo";

import { File, MultiRepoFileMap } from "./filemap";
import * as filemap from "./filemap";

import { GitOp, MultiRepoGitOps } from "./git_ops";

import { FileKind } from "./utils/path_utils";
import * as path_utils from "./utils/path_utils";

// ----------------------------------------------------------------------------
// ResultAsync helper
// ----------------------------------------------------------------------------

function expect<T>(promise: Promise<T>): ResultAsync<T, Error> {
  return ResultAsync.fromPromise(promise, (e) => e as Error);
}

function wrapPromise<T>(promise: Promise<T>, msg: string): ResultAsync<T, WrappedError> {
  return ResultAsync.fromPromise(promise, (error) => {
    console.log(msg, error);
    return {
      msg: msg,
      originalError: error as Error,
    };
  });
}

function startChain(): ResultAsync<null, WrappedError> {
  return okAsync(null);
}

// ----------------------------------------------------------------------------
// High level functions
// ----------------------------------------------------------------------------

export async function verifyRepo(repo: Repo) {
  const octokit = new Octokit({
    auth: repo.token,
  });

  let content = await expect(
    octokit.repos.getContent({
      owner: repo.userName,
      repo: repo.repoName,
      path: ".",
    })
  );

  if (content.isOk()) {
    console.log("Verification succeeded.");
    return true;
  } else {
    console.log("Verification failed:");
    console.log(content.error);
    return false;
  }
}

// ----------------------------------------------------------------------------
// Storage utils
// ----------------------------------------------------------------------------

// Encoding reference:
// https://stackoverflow.com/questions/30106476/using-javascripts-atob-to-decode-base64-doesnt-properly-decode-utf-8-strings

export function base64EncodeUnicode(s: string): string {
  // first we use encodeURIComponent to get percent-encoded UTF-8,
  // then we convert the percent encodings into raw bytes which
  // can be fed into btoa.
  return btoa(
    encodeURIComponent(s).replace(/%([0-9A-F]{2})/g, function toSolidBytes(match, p1) {
      return String.fromCharCode(parseInt("0x" + p1));
    })
  );
}

export function base64DecodeUnicode(s: string): string {
  // Going backwards: from bytestream, to percent-encoding, to original string.
  return decodeURIComponent(
    atob(s)
      .split("")
      .map(function (c) {
        return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
      })
      .join("")
  );
}

export function clearBrowserCache() {
  localforage.clear();
}

// ----------------------------------------------------------------------------
// Internal cached fetching
// ----------------------------------------------------------------------------

function cachedFetch(
  octokit: Octokit,
  repo: Repo,
  path: string,
  sha: string
): ResultAsync<string, WrappedError> {
  let key = `${path}_${sha}`;

  return wrapPromise(
    localforage.getItem(key) as Promise<string | undefined>,
    "Failed to get item from local storage."
  ).andThen((cached) => {
    if (cached != null) {
      // console.log(`${key} found in cached`)
      return okAsync(cached);
    } else {
      return wrapPromise(
        octokit.repos.getContent({
          owner: repo.userName,
          repo: repo.repoName,
          path: path,
        }),
        "Failure during fetching file from GitHub."
      ).map((response) => {
        console.log(`${key} fetched successfully`);
        //console.log(content)

        // TODO: Turn these into Result errors...
        console.assert(response.data.sha === sha, "SHA mismatch");
        console.assert(response.data.encoding === "base64", "Encoding mismatch");

        // The following simple base64 -> string decoding has problem if the content is actually UTF-8.
        // let plainContent = atob(content.data.content)

        // TODO: How can we know that the decoded content is actually UTF-8 encoded?
        // Perhaps we need to have a property on a note that represents "original encoding".
        // Alternatively we could have a heuristic? How does the `file` utility does it?
        // It would be interesting to add a markdown file with some Windows encoding.
        let plainContent = base64DecodeUnicode(response.data.content);
        // console.log(plainContent)

        localforage.setItem(key, plainContent);

        return plainContent;
      });
    }
  });
}

// ----------------------------------------------------------------------------
// Recursive file listing
// ----------------------------------------------------------------------------

type FileDesc = {
  path: string;
  sha: string;
  rawUrl: string;
};

async function listFilesRecursive(octokit: Octokit, repo: Repo, path: string, files: FileDesc[]) {
  console.log("recursiveListFiles", path);

  let response = await wrapPromise(
    octokit.repos.getContent({
      owner: repo.userName,
      repo: repo.repoName,
      path: path,
    }),
    "octokit.repos.getContent"
  );

  if (response.isOk()) {
    // console.log(result)
    // Reference for fields:
    // https://developer.github.com/v3/repos/contents/#get-repository-content
    // I think the types are slightly wrong, because the return type is only a
    // ReposGetContentResponseData if the requested path was a file/symlink/....
    // In the case of a directory it should be a ReposGetContentResponseData[].
    let responseData = (response.value.data as unknown) as ReposGetContentResponseData[];

    for (let entry of responseData) {
      if (entry.type === "dir") {
        // It is important to await the recursive load, otherwise the outer logic does not
        // even know what / how many promises there will be scheduled.
        await listFilesRecursive(octokit, repo, entry.path, files);
      } else if (entry.type === "file") {
        files.push({
          path: entry.path,
          sha: entry.sha,
          rawUrl: entry.download_url,
        });
      }
    }
  } else {
    // TODO: We need to communicate to the outside that an error has occurred.
    // Probably best to have another `errors: WrapperError[]` argument that
    // can be pushed to.
    console.log("WARNING: Failed to get repo content:");
    console.log(response.error.originalError);
  }
}

async function listFiles(octokit: Octokit, repo: Repo, path: string): Promise<FileDesc[]> {
  // It is important to await the recursive load, otherwise the 'out' variables will
  // just stay empty...
  let files = [] as FileDesc[];
  await listFilesRecursive(octokit, repo, path, files);
  return files;
}

// ----------------------------------------------------------------------------
// Recursive downloading
// ----------------------------------------------------------------------------

async function downloadFiles(octokit: Octokit, repo: Repo): Promise<File[]> {
  let files = await listFiles(octokit, repo, ".");

  let fileFetches: ResultAsync<File, File>[] = [];

  for (let file of files) {
    let fileKind = path_utils.getFileKind(file.path);
    let doFetch =
      fileKind !== FileKind.Document || file.path.startsWith(path_utils.NOTEMARKS_FOLDER);

    if (doFetch) {
      fileFetches.push(
        cachedFetch(octokit, repo, file.path, file.sha)
          .map((content) => ({
            path: file.path,
            sha: file.sha,
            rawUrl: file.rawUrl,
            content: content,
          }))
          .mapErr((error) => ({
            path: file.path,
            sha: file.sha,
            rawUrl: file.rawUrl,
            error: error,
          }))
      );
    } else {
      fileFetches.push(
        okAsync({
          path: file.path,
          sha: file.sha,
          rawUrl: file.rawUrl,
        })
      );
    }
  }

  let allResults = await Promise.all(fileFetches);
  return allResults.map((result) => (result.isOk() ? result.value : result.error));
}

// ----------------------------------------------------------------------------
// High level entry loading
// ----------------------------------------------------------------------------

// TODO: Possible extension of return value to tuple containing:
// - entries
// - load errors
// - load statistics like "X files downloaded", "Y files from cache"?
// - staged changes
export async function loadEntries(
  repos: Repos
): Promise<[EntryFile[], MultiRepoFile, MultiRepoGitOps]> {
  console.log(`Loading contents from ${repos.length} repos`);

  let allEntries = [] as EntryFile[];
  let allLinkDBs = new MultiRepoFile();
  let allErrors = [] as WrappedError[];
  let allFileMaps = new MultiRepoFileMap();
  let stagedChanges = {} as MultiRepoGitOps;

  for (let repo of repos) {
    const octokit = new Octokit({
      auth: repo.token,
    });

    let files = await downloadFiles(octokit, repo);
    let fileMap = filemap.convertFilesToFileMap(files);
    allFileMaps.set(repo, fileMap);

    let fileLinkDB = fileMap.get(path_utils.NOTEMARKS_LINK_DB_PATH);
    if (fileLinkDB != null && fileLinkDB.content != null) {
      allLinkDBs.set(repo, fileLinkDB.content);
    }
  }

  console.log(allEntries);
  console.log(allLinkDBs);
  console.log(allErrors);
  let [fileEntries, allFileMapsPatched] = filemap.extractFileEntriesAndUpdateFileMap(allFileMaps);

  console.log(fileEntries);
  console.log(allFileMapsPatched);

  return [fileEntries, allLinkDBs, stagedChanges];
}

// ----------------------------------------------------------------------------
// Commit
// ----------------------------------------------------------------------------

// http://www.levibotelho.com/development/commit-a-file-with-the-github-api/

type GitCreateTreeParamsTree = {
  path?: string;
  mode?: "100644" | "100755" | "040000" | "160000" | "120000";
  type?: "blob" | "tree" | "commit";
  sha?: string | null;
  content?: string;
};

export function commit(
  repo: Repo,
  ops: GitOp[],
  commitMsg: string
): ResultAsync<string, WrappedError> {
  const octokit = new Octokit({
    auth: repo.token,
  });

  let oldCommitSHA: string;
  let newCommitSHA: string;

  return startChain()
    .andThen(() => {
      return octokitGetRef(
        octokit,
        repo,
        "heads/main" // TODO repo must contain branch or infer default branch...
      );
    })
    .andThen((response) => {
      oldCommitSHA = response.data.object.sha;
      return octokitGetCommit(octokit, repo, oldCommitSHA);
    })
    .andThen((response) => {
      let oldTreeSHA = response.data.tree.sha;
      return octokitGetTree(octokit, repo, oldTreeSHA);
    })
    .andThen((response) => {
      if (response.data.truncated) {
        return errAsync({
          msg: "Tree has been truncated -- handling that many files is not supported yet.",
          error: null,
        }) as ResultAsync<OctokitResponse<GitCreateTreeResponseData>, WrappedError>;
      }
      let oldTree: GitGetTreeResponseData = response.data;
      let newTree: GitCreateTreeParamsTree[] = applyOps(ops, oldTree);

      console.log(oldTree);
      console.log(newTree);

      return octokitCreateTree(octokit, repo, newTree);
    })
    .andThen((response) => {
      let newTreeSHA = response.data.sha;
      return octokitCreateCommit(octokit, repo, commitMsg, oldCommitSHA, newTreeSHA);
    })
    .andThen((response) => {
      newCommitSHA = response.data.sha;
      return octokitUpdateRef(octokit, repo, "heads/main", newCommitSHA);
    })
    .map(() => newCommitSHA);
}

function octokitGetRef(octokit: Octokit, repo: Repo, ref: string) {
  return wrapPromise(
    octokit.git.getRef({
      owner: repo.userName,
      repo: repo.repoName,
      ref: "heads/main", // TODO repo must contain branch or infer default branch...
    }),
    "Failed to get head ref."
  );
}

function octokitGetCommit(octokit: Octokit, repo: Repo, commitSHA: string) {
  return wrapPromise(
    octokit.git.getCommit({
      owner: repo.userName,
      repo: repo.repoName,
      commit_sha: commitSHA,
    }),
    "Failed to get head commit."
  );
}

function octokitGetTree(octokit: Octokit, repo: Repo, treeSHA: string) {
  // TODO: getTree seems to fail if a repo is completely empty.
  // How to recover from that?
  return wrapPromise(
    octokit.git.getTree({
      owner: repo.userName,
      repo: repo.repoName,
      tree_sha: treeSHA,
      recursive: "true",
    }),
    `Failed to get tree with sha ${treeSHA}.`
  );
}

function octokitCreateTree(octokit: Octokit, repo: Repo, tree: GitCreateTreeParamsTree[]) {
  return wrapPromise(
    octokit.git.createTree({
      owner: repo.userName,
      repo: repo.repoName,
      tree: tree,
    }),
    "Failed to create tree."
  );
}

function octokitCreateCommit(
  octokit: Octokit,
  repo: Repo,
  commitMsg: string,
  oldCommitSHA: string,
  newTreeSHA: string
) {
  return wrapPromise(
    octokit.git.createCommit({
      owner: repo.userName,
      repo: repo.repoName,
      message: commitMsg,
      parents: [oldCommitSHA],
      tree: newTreeSHA,
    }),
    "Failed to create commit."
  );
}

function octokitUpdateRef(octokit: Octokit, repo: Repo, ref: string, commitSHA: string) {
  return wrapPromise(
    octokit.git.updateRef({
      owner: repo.userName,
      repo: repo.repoName,
      ref: ref,
      sha: commitSHA,
      force: true,
    }),
    "Failed to update ref."
  );
}

function applyOps(ops: GitOp[], oldTree: GitGetTreeResponseData): GitCreateTreeParamsTree[] {
  // https://developer.github.com/v3/git/trees/#create-a-tree

  let newTree: GitCreateTreeParamsTree[] = [];

  // Merge-in existing tree content
  for (let entry of oldTree.tree) {
    let keep = true;
    let destinationPath = entry.path;
    for (let op of ops) {
      // In both write/remove cases we don't keep the existing SHA
      // In theory we could check whether in the write case the existing
      // file actually has the expected content already. However, overwriting
      // does not seem to be forbidden, and typically the content is expected
      // to be modified anyway.
      if (op.kind !== "move" && op.path === entry.path) {
        keep = false;
        break;
      } else if (op.kind === "move" && op.pathFrom === entry.path) {
        destinationPath = op.pathTo;
      }
    }

    // As mentioned in the blog post, it seems necessary to omit "tree" elements from
    // the new tree. In contrast to what is mentioned in the blog post however, this
    // did not error with a 500. Even worse, it succeeded, but it did had any "delete"
    // behavior. Files omitted in the new tree were still there, perhaps because their
    // parent tree elements were in the new tree as well. To get the desired behavior
    // removing tree elements seems still necessary.
    if (entry.type === "tree") {
      keep = false;
    }

    if (keep) {
      newTree.push({
        path: destinationPath,
        mode: entry.mode as any,
        type: entry.type as any,
        sha: entry.sha,
      });
    }
  }

  // Merge-in new writes
  for (let op of ops) {
    if (op.kind === "write") {
      newTree.push({
        path: op.path,
        mode: "100644", // blob non-executable
        type: "blob",
        content: op.content,
      });
    }
  }

  return newTree;
}
