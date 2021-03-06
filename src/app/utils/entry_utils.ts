import { ok, Result } from "neverthrow";

import {
  Content,
  ContentDoc,
  ContentNote,
  ContentLink,
  ContentFile,
  EntryKind,
  Entry,
  Entries,
  EntryDoc,
  EntryNote,
  EntryLink,
  EntryFile,
  RawLabel,
} from "../types";
import { Repo, getRepoId } from "../repo";

import { MetaData, StoredLinks } from "../io";
import * as io from "../io";

import { FileKind } from "./path_utils";
import * as path_utils from "./path_utils";

import { File, isFileInGit, isFileFetched, MultiRepoFileMap } from "../filemap";

import * as markdown_utils from "./markdown_utils";
import * as label_utils from "./label_utils";

const entryKindNumericValues = {
  [EntryKind.NoteMarkdown]: 0,
  [EntryKind.Document]: 1,
  [EntryKind.Link]: 2,
};

export function sortAndIndexEntries(entries: Entries) {
  entries.sort((a, b) => {
    if (a.content.kind !== b.content.kind) {
      return entryKindNumericValues[a.content.kind] - entryKindNumericValues[b.content.kind];
    } else {
      return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
    }
  });
  for (let i = 0; i < entries.length; ++i) {
    entries[i].idx = i;
  }
}

export function recomputeKey<T extends Entry>(entry: T): T {
  // For some reason the compiler doesn't understand isFile(entry) here...
  if (isFileContent(entry.content)) {
    let path = path_utils.getPath(entry as EntryFile);
    entry.key = `${entry.content.repo.key}:${path}`;
  } else {
    entry.key = `__link_${entry.content.target}`;
  }
  return entry;
}

/*
User defined type guard helpers:
https://www.typescriptlang.org/docs/handbook/advanced-types.html#user-defined-type-guards

Regarding nesting see:
https://stackoverflow.com/questions/65347424/user-defined-type-guard-on-outer-type-nested-property
*/

// On Content

export function isDocContent(content: Content): content is ContentDoc {
  return content.kind === EntryKind.Document;
}

export function isNoteContent(content: Content): content is ContentNote {
  return content.kind === EntryKind.NoteMarkdown;
}

export function isLinkContent(content: Content): content is ContentLink {
  return content.kind === EntryKind.Link;
}

export function isFileContent(content: Content): content is ContentFile {
  return content.kind === EntryKind.Document || content.kind === EntryKind.NoteMarkdown;
}

// On Entry

export function isDoc(entry: Entry): entry is EntryDoc {
  return entry.content.kind === EntryKind.Document;
}

export function isNote(entry: Entry): entry is EntryNote {
  return entry.content.kind === EntryKind.NoteMarkdown;
}

export function isLink(entry: Entry): entry is EntryLink {
  return entry.content.kind === EntryKind.Link;
}

export function isFile(entry: Entry): entry is EntryFile {
  return entry.content.kind === EntryKind.Document || entry.content.kind === EntryKind.NoteMarkdown;
}

// Other Helpers

export function getText(entry: Entry): string | undefined {
  if (entry.content.kind === EntryKind.NoteMarkdown) {
    return entry.content.text;
  }
}

// ----------------------------------------------------------------------------
// File entry extraction from FileMap
// ----------------------------------------------------------------------------

export function extractFileEntriesAndUpdateFileMap(
  allFileMapsOrig: MultiRepoFileMap
): [EntryFile[], MultiRepoFileMap] {
  let fileEntries: EntryFile[] = [];
  let allFileMapsEdit = allFileMapsOrig.clone();

  allFileMapsOrig.forEach((repo, fileMap) => {
    fileMap.forEach((file) => {
      let isNotemarksFile = path_utils.isNotemarksFile(file.path);
      if (!isNotemarksFile) {
        // For meta data there are three cases:
        // - No meta file exists => okay, create/stage new
        // - Meta file exists, but fetch fails => create/stage not good, report as error,
        //   remove the corresponding entry to avoid accidentally overwriting the (possibly
        //   valid) meta file.
        // - Meta file exists, fetch is okay, but parse fails => In this case staging seems
        //   okay. If meta data is broken, users may want to have it fixed anyway. Also
        //   a user sees this action clearly by the staged change, and git history is
        //   recoverable anyway.

        let associatedMetaPath = path_utils.getAssociatedMetaPath(file.path);
        let associatedMetaFile = fileMap.get(associatedMetaPath);
        let createMetaDataFromScratch = false;

        if (associatedMetaFile != null && associatedMetaFile.content != null) {
          // Meta file fetch successful
          let metaData = io.parseMetaData(associatedMetaFile.content);
          if (metaData.isOk()) {
            // Parse successful
            let entry = constructFileEntry(repo, file, metaData.value);
            if (entry != null) {
              fileEntries.push(entry);
            }
          } else {
            // Parse failed => load entry + stage fix
            createMetaDataFromScratch = true;
          }
        } else if (associatedMetaFile != null && associatedMetaFile.error != null) {
          // Meta file fetch failed
          console.log(
            `Skipping entry extraction for ${file.path} because associated meta couldn't be fetched.`
          );
        } else {
          // No meta file at all => load entry + stage fix
          createMetaDataFromScratch = true;
        }

        if (createMetaDataFromScratch) {
          let newMetaData = io.createNewMetaData();
          let newMetaDataContent = io.serializeMetaData(newMetaData);
          let entry = constructFileEntry(repo, file, newMetaData);
          if (entry != null) {
            fileEntries.push(entry);
            allFileMapsEdit.get(repo)?.data.setContent(associatedMetaPath, newMetaDataContent);
          }
        }
      } else if (!isFileFetched(file)) {
        console.log(file);
      }
    });
  });

  return [fileEntries, allFileMapsEdit];
}

export function constructFileEntry(
  repo: Repo,
  file: File,
  metaData: MetaData
): EntryFile | undefined {
  let fileKind = path_utils.getFileKind(file.path);
  let [location, title, extension] = path_utils.splitLocationTitleExtension(file.path);

  let content: Content;
  // Regarding double enum conversion
  // https://stackoverflow.com/a/42623905/1804173
  // https://stackoverflow.com/questions/55377365/what-does-keyof-typeof-mean-in-typescript
  if (fileKind === FileKind.NoteMarkdown && isFileFetched(file)) {
    let text = file.content;
    let [html, links] = markdown_utils.processMarkdownText(text);

    content = {
      kind: (fileKind as keyof typeof FileKind) as EntryKind.NoteMarkdown,
      repo: repo,
      location: location,
      extension: extension,
      timeCreated: metaData.timeCreated as Date,
      timeUpdated: metaData.timeUpdated as Date,
      rawUrl: file.rawUrl,
      text: text,
      html: html,
      links: links,
    };
  } else if (fileKind === FileKind.Document && isFileInGit(file)) {
    content = {
      kind: (fileKind as keyof typeof FileKind) as EntryKind.Document,
      repo: repo,
      location: location,
      extension: extension,
      timeCreated: metaData.timeCreated as Date,
      timeUpdated: metaData.timeUpdated as Date,
      rawUrl: file.rawUrl,
    };
  } else {
    console.log("ERROR: Could not create file entry for:", file);
    return undefined;
  }

  return recomputeKey({
    title: title,
    priority: 0,
    labels: metaData.labels,
    content: content,
  });
}

// ----------------------------------------------------------------------------
// High level Link DB loading/storing
// ----------------------------------------------------------------------------

export function extractLinkEntriesFromLinkDB(allFileMaps: MultiRepoFileMap): EntryLink[] {
  let allLinkEntriesWithoutRefsResolved = [] as EntryLink[];
  allFileMaps.forEach((repo, fileMap) => {
    let fileLinkDB = fileMap.get(path_utils.NOTEMARKS_LINK_DB_PATH);
    if (fileLinkDB != null && fileLinkDB.content != null) {
      let linkEntriesWithoutRefsResolvedResult = deserializeLinkEntries(repo, fileLinkDB.content);
      if (linkEntriesWithoutRefsResolvedResult.isOk()) {
        // TODO: We need duplicate removal here...
        allLinkEntriesWithoutRefsResolved = [
          ...allLinkEntriesWithoutRefsResolved,
          ...linkEntriesWithoutRefsResolvedResult.value,
        ];
      }
    }
  });
  return allLinkEntriesWithoutRefsResolved;
}

export function stageLinkDBUpdate(linkEntries: EntryLink[], allFileMapsEdit: MultiRepoFileMap) {
  console.time("stageLinkDBUpdate");

  allFileMapsEdit.forEach((repo, fileMap) => {
    let serializedLinkEntries = serializeLinkEntries(repo, linkEntries);
    fileMap.setContent(path_utils.NOTEMARKS_LINK_DB_PATH, serializedLinkEntries);
  });

  console.timeEnd("stageLinkDBUpdate");
}

// ----------------------------------------------------------------------------
// Link entry serialization/deserialization (via StoredLinks conversion)
// ----------------------------------------------------------------------------

function serializeLinkEntries(repo: Repo, linkEntries: EntryLink[]): string {
  let storedLinks: StoredLinks = linkEntries
    .filter(
      (linkEntry) =>
        linkEntry.content.refRepos.some((refRepo) => getRepoId(refRepo) === getRepoId(repo)) ||
        (linkEntry.content.standaloneRepo != null &&
          getRepoId(linkEntry.content.standaloneRepo) === getRepoId(repo))
    )
    .map((linkEntry) => ({
      title: linkEntry.title,
      target: linkEntry.content.target,
      ownLabels: linkEntry.content.ownLabels,
      standalone:
        linkEntry.content.standaloneRepo != null &&
        getRepoId(linkEntry.content.standaloneRepo) === getRepoId(repo),
    }));
  return io.serializeStoredLinks(storedLinks);
}

function deserializeLinkEntries(repo: Repo, content?: string): Result<EntryLink[], Error> {
  let storedLinks =
    content != null ? io.parseStoredLinks(content) : (ok([]) as Result<StoredLinks, Error>);
  return storedLinks.map((storedLinks) =>
    storedLinks.map((storedLink) =>
      recomputeKey({
        title: storedLink.title,
        priority: 0, // TODO: needs to be stored?
        labels: storedLink.ownLabels,
        content: {
          kind: EntryKind.Link,
          target: storedLink.target,
          referencedBy: [],
          standaloneRepo: storedLink.standalone ? repo : undefined,
          refRepos: [],
          refLocations: [],
          ownLabels: storedLink.ownLabels,
        },
      })
    )
  );
}

// ----------------------------------------------------------------------------
// Meta data extraction
// ----------------------------------------------------------------------------

export function extractMetaData(entry: EntryFile): MetaData {
  return {
    labels: entry.labels,
    timeCreated: entry.content.timeCreated,
    timeUpdated: entry.content.timeUpdated,
  };
}

// ----------------------------------------------------------------------------
// File + link entry fusion
// ----------------------------------------------------------------------------

export function mergeLabels(existingLabels: RawLabel[], incomingLabels: RawLabel[]): RawLabel[] {
  return label_utils.normalizeLabels([...existingLabels, ...incomingLabels]);
}

export function mergeRepos(existingRepos: Repo[], incomingRepo: Repo): Repo[] {
  if (!existingRepos.some((existingRepo) => getRepoId(existingRepo) === getRepoId(incomingRepo))) {
    existingRepos.push(incomingRepo);
  }
  return existingRepos;
}

export function mergeLocations(existingLocations: string[], incomingLocation: string): string[] {
  if (!existingLocations.some((existingLocation) => existingLocation === incomingLocation)) {
    existingLocations.push(incomingLocation);
  }
  return existingLocations;
}

export function recomputeLinkEntries(
  fileEntries: EntryFile[],
  existingLinkEntries: EntryLink[]
): EntryLink[] {
  console.time("link extraction");

  /*
  If the links variable contains the current array of EntryLinks, how
  should this loop look like exactly? In order to allow for non-standalone
  to disappear, we should actually only insert standalone links in the
  results. However, this would mean that we lose the title and labels
  information that is directly attached to these links (the links
  inferred below can only be initialized with the default title equaling
  the link target, and the labels directly inherited from the note).
  Therefore, we should insert all existing links to the result, but
  we would need a post-processing to remove those links that are not
  standalone and did not get any references attached. A bit ugly.

  Better idea: Use two data structures:
  - The final link result list
  - An internal lookup for existing links
  - An internal lookup to keep track of what has already been inserted
    to the result.

  The loop can fill standalone links directly into the result.

  Non-standalone links can be added to the lookup map so that if they
  are needed in the infer part below they can be read from there.

  The third data structure is needed, because there are three cases
  to consinder in the lower loop:
  - The file entry references a link that is not at all in the link map
    => create new.
  - The file entry references a link that is in the link map, but hasn't been inserted
    => update refs and insert
  - The file entry references a link that is in the link map and has been inserted
    => only update refs
  */

  let linkEntries = [] as EntryLink[];
  let linkMap: { [link: string]: EntryLink } = {};
  let linkInserted: { [link: string]: boolean } = {};

  for (let link of existingLinkEntries) {
    /*
    // We need to 'reset' the link data so that the infered fields can be computed from scratch.
    // Perhaps pull this out into a `cloneResetLink` helper function for better testability.
    let resetLinkEntry: EntryLink = {
      title: link.title,
      priority: link.priority,
      labels: link.content.ownLabels,
      content: {
        kind: EntryKind.Link,
        target: link.content.target,
        referencedBy: [],
        refRepos: [],
        refLocations: [],
        standaloneRepo: link.content.standaloneRepo,
        ownLabels: link.content.ownLabels,
      },
      key: link.key,
    };
    */
    // EDIT: We need to keep the identity of link entries to re-identify their
    // index after `recomputeEntries`, therere we currently mutate instead of
    // clone.
    link.content.referencedBy = [];
    link.content.refRepos = [];
    link.content.refLocations = [];
    link.labels = link.content.ownLabels.slice(0);

    // We assume that existingLinks do not contain duplicate links? I.e., no different link
    // data (title/labels) for the same link target. If existingLinks is the result of a
    // previous processing this should be satisfied, because identical link targets would
    // have been fused. The only exception is the case where the existing links are read
    // from the repo in the initial load -- and the user has manually violated the
    // invariant. We simply ignore any duplicate link record here.
    if (!(link.content.target in linkMap)) {
      if (link.content.standaloneRepo != null) {
        linkEntries.push(link);
        linkInserted[link.content.target] = true;
      }
      linkMap[link.content.target] = link;
    } else {
      console.log(`WARNING: Existing links contains duplicate ${link.content.target}. Discarding.`);
    }
  }

  for (let entry of fileEntries) {
    if (isNote(entry)) {
      for (let linkTarget of entry.content.links) {
        // TODO: rename entry.content.links to linkTargets because they aren't "real" links?
        if (!(linkTarget in linkMap)) {
          let linkEntry: EntryLink = recomputeKey({
            title: linkTarget, // TODO fetch here but then this whole thing becomes async and slow?
            priority: 0,
            labels: entry.labels.slice(0),
            content: {
              kind: EntryKind.Link,
              target: linkTarget,
              referencedBy: [entry],
              refRepos: [entry.content.repo],
              refLocations: [entry.content.location],
              ownLabels: [],
            },
          });
          linkEntries.push(linkEntry);
          linkInserted[linkTarget] = true;
          linkMap[linkTarget] = linkEntry;
        } else {
          let linkEntry = linkMap[linkTarget];
          linkEntry.content.referencedBy.push(entry);
          linkEntry.content.refRepos = mergeRepos(linkEntry.content.refRepos, entry.content.repo);
          linkEntry.content.refLocations = mergeLocations(
            linkEntry.content.refLocations,
            entry.content.location
          );
          linkEntry.labels = mergeLabels(linkEntry.labels, entry.labels);
          if (!(linkTarget in linkInserted)) {
            linkEntries.push(linkEntry);
            linkInserted[linkEntry.content.target] = true;
          }
        }
      }
    }
  }

  // TODO: Check if we have to sort the labels attached to links.
  // In case we call mergeLabels, they should be sorted, because it sorts
  // internally. However, we initialize by `ownLabels` and if we never
  // call mergeLabels (i.e. no reference = standalone link), we would
  // never sort them, and it is maybe not good to rely on them
  // being sorted on disc?
  // Perhaps it is easier to get rid of sorting them during the merge
  // but rather have an explicit sort post-processing.
  // **EDIT** Now that mergeLabels internally performs a full normalization
  // this should be covered, right?

  console.timeEnd("link extraction");
  // console.log(linkMap);
  return linkEntries;
}

export function recomputeEntries(
  fileEntries: EntryFile[],
  existingLinkEntries: EntryLink[]
): [EntryLink[], Entries] {
  let linkEntries = recomputeLinkEntries(fileEntries, existingLinkEntries);
  let entries = [...fileEntries, ...linkEntries];

  sortAndIndexEntries(entries);

  return [linkEntries, entries];
}
