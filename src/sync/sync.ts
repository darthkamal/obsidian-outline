import { getOutlineMeta, resolveWikiLinkMarkers, stripFrontmatter } from '../pipeline';
import { buildDocumentTree } from '../pipeline';
import type { DocNode } from '../pipeline';
import { convertContentToOutlineMarkdown } from '../convert';
import { getErrorMessage } from '../utils/errors';
import { hashContent } from '../utils/content-hash';
import type {
  SyncOptions,
  SyncEnv,
  SyncResult,
  SyncDocumentResult,
  SyncPartialFailure,
  ConflictResolution,
  FileDescriptor,
} from './types';

async function findAvailableTitle(
  api: SyncEnv['api'],
  baseTitle: string,
  collectionId: string,
  parentDocumentId?: string
): Promise<string> {
  const MAX_ATTEMPTS = 50;
  let counter = 1;
  let candidate = `${baseTitle}-${counter}`;
  while (
    counter <= MAX_ATTEMPTS &&
    (await api.searchDocumentByTitle(candidate, collectionId, parentDocumentId))
  ) {
    counter++;
    candidate = `${baseTitle}-${counter}`;
  }
  return candidate;
}

/**
 * Sync a single document. Used for one-file push and as the inner step for folder sync.
 */
export async function syncDocument(
  options: SyncOptions,
  env: SyncEnv,
  fd: FileDescriptor,
  parentDocumentId?: string
): Promise<SyncDocumentResult | null> {
  const rawContent = await env.readFile(fd);
  const meta = getOutlineMeta(rawContent);

  // Hash of the body only: the frontmatter carries sync metadata that this
  // function itself rewrites, so including it would change the hash on every
  // push and nothing would ever be skipped.
  //
  // The render-affecting options go in too. Without them, switching to a public
  // URL (or toggling TOC removal) would leave every already-synced note looking
  // "unchanged", so its links would keep pointing at the old base URL forever.
  const contentHash = hashContent(
    stripFrontmatter(rawContent) +
      `\n<<outline-render>>${options.outlineUrl}|${options.removeToc ? '1' : '0'}`
  );

  // Skip notes whose body is byte-identical to the last successful push. On a
  // large vault this is the difference between re-pushing everything and
  // pushing the few notes that changed. The document id is still returned so
  // child documents keep their parent.
  if (options.skipUnchanged && meta.outline_id && meta.outline_content_hash === contentHash) {
    return {
      documentId: meta.outline_id,
      collectionId: options.collectionId,
      action: 'skipped',
    };
  }

  const wikiResolver = env.getWikiResolver();
  const { markdown, imageRefs } = convertContentToOutlineMarkdown(
    rawContent,
    {
      removeToc: options.removeToc,
      outlineUrl: options.outlineUrl,
      preserveUnresolved: options.preserveUnresolved,
    },
    fd.basename,
    fd.path,
    wikiResolver
  );

  const collectionId = options.collectionId;
  let knownDoc = meta.outline_id ? await env.api.getDocument(meta.outline_id) : null;
  if (knownDoc && knownDoc.collectionId !== collectionId) {
    knownDoc = null;
  }
  const duplicate = knownDoc
    ? { id: knownDoc.id!, collectionId: knownDoc.collectionId! }
    : await env.api.searchDocumentByTitle(fd.basename, collectionId, parentDocumentId);

  let documentId: string;
  let documentCollectionId: string;
  let action: 'created' | 'updated';
  let resolution: ConflictResolution = 'overwrite';

  if (duplicate) {
    if (env.resolveConflict) {
      resolution = await env.resolveConflict(fd.basename);
      if (resolution === 'cancel') return null;
    } else {
      resolution = options.folderConflictStrategy;
    }

    if (resolution === 'overwrite') {
      const updated = await env.api.updateDocument({
        id: duplicate.id!,
        title: fd.basename,
        text: markdown,
        publish: true,
      });
      // updateDocument throws on any non-200; this only guards the narrow
      // case of a 200 response with no document data.
      if (!updated) throw new Error('Outline returned success but no document data');
      documentId = duplicate.id!;
      documentCollectionId = duplicate.collectionId!;
      action = 'updated';
    } else {
      const uniqueTitle = await findAvailableTitle(
        env.api,
        fd.basename,
        collectionId,
        parentDocumentId
      );
      const created = await env.api.createDocument({
        title: uniqueTitle,
        text: markdown,
        collectionId,
        publish: true,
        parentDocumentId,
      });
      if (!created) throw new Error('Outline returned success but no document data');
      documentId = created.id!;
      documentCollectionId = created.collectionId!;
      action = 'created';
    }
  } else {
    const created = await env.api.createDocument({
      title: fd.basename,
      text: markdown,
      collectionId,
      publish: true,
      parentDocumentId,
    });
    if (!created) throw new Error('Outline returned success but no document data');
    documentId = created.id!;
    documentCollectionId = created.collectionId!;
    action = 'created';
  }

  let finalMarkdown = markdown;
  let imagesUploaded = 0;
  // Single flag for "was this push fully successful", set from every failure
  // source below. A separate counter and a separate error variable used to be
  // checked together by hand at the end -- easy for a future failure mode to
  // update only one and silently reintroduce the "incomplete push recorded as
  // complete" bug this flag exists to prevent.
  let pushIncomplete = false;
  let finalUpdateError: unknown = null;
  if (imageRefs.length > 0) {
    // Sequential, not concurrent, on purpose: the measured bottleneck on a
    // slow link is sustained upload throughput (~130KB/s in the real-vault
    // test, migration/findings.md #4.2), not request latency. Uploading in
    // parallel would split one constrained pipe between several transfers
    // instead of speeding it up, making each one more likely to hit the
    // server's per-connection timeout.
    for (const ref of imageRefs) {
      const resolved = env.resolveImage(fd, ref);
      if (!resolved) {
        finalMarkdown = finalMarkdown.replace(
          ref.placeholder,
          `*(Image not found: ${ref.imageName})*`
        );
        continue;
      }
      const bytes = await env.readImageBytes(resolved.pathOrKey);
      const attachment = await env.api.createAttachment({
        name: resolved.fileName,
        contentType: resolved.contentType,
        size: bytes.byteLength,
        documentId,
      });
      if (!attachment?.uploadUrl || !attachment.form) {
        pushIncomplete = true;
        finalMarkdown = finalMarkdown.replace(
          ref.placeholder,
          `*(Upload failed: ${resolved.fileName})*`
        );
        continue;
      }
      const uploaded = await env.api.uploadAttachmentToStorage(
        attachment.uploadUrl,
        attachment.form,
        bytes,
        resolved.contentType
      );
      if (uploaded) {
        const url = attachment.attachment?.url ?? '';
        // Only images embed inline. Audio, video and documents render as a
        // file link, which is how Outline presents non-image attachments.
        const replacement = ref.isImage
          ? `![${resolved.fileName.replace(/\.[^.]+$/, '')}](${url})`
          : `[${resolved.fileName}](${url})`;
        finalMarkdown = finalMarkdown.replace(ref.placeholder, replacement);
        imagesUploaded++;
      } else {
        pushIncomplete = true;
        finalMarkdown = finalMarkdown.replace(
          ref.placeholder,
          `*(Upload failed: ${resolved.fileName})*`
        );
      }
    }
    // updateDocument throws on failure. The document already exists at this
    // point, so letting the throw escape before the frontmatter is written
    // would strand it: the note would keep no outline_id and the next run
    // would create a duplicate. Record the failure, write the id, then rethrow.
    try {
      await env.api.updateDocument({
        id: documentId,
        title: fd.basename,
        text: finalMarkdown,
        publish: true,
      });
    } catch (e) {
      finalUpdateError = e;
      pushIncomplete = true;
    }
  }

  await env.writeFrontmatter(fd, {
    outlineId: documentId,
    collectionId: documentCollectionId,
    contentHash: pushIncomplete ? undefined : contentHash,
  });

  if (finalUpdateError) {
    // The document itself was created/updated successfully above -- only the
    // post-image content push failed. Attach the real id so a caller walking
    // a document tree (syncFolder) can still attach this note's children to
    // it instead of losing the parent relationship for the rest of the run.
    if (finalUpdateError instanceof Error) {
      (finalUpdateError as Error & SyncPartialFailure).partialResult = {
        documentId,
        collectionId: documentCollectionId,
      };
    }
    throw finalUpdateError;
  }

  const imageStats =
    imageRefs.length > 0 ? { uploaded: imagesUploaded, total: imageRefs.length } : undefined;

  return { documentId, collectionId, action, imageStats, finalMarkdown };
}

/**
 * Sync a full folder: build tree from listed files, then sync each document in order.
 */
export async function syncFolder(
  options: SyncOptions,
  env: SyncEnv,
  rootPath: string
): Promise<SyncResult> {
  const files = await env.listMarkdownFiles(rootPath);
  if (files.length === 0) {
    env.onProgress?.('No markdown files found.');
    return { success: 0, failed: 0, skipped: 0, total: 0 };
  }

  env.onProgress?.(`Found ${files.length} markdown file(s)`);
  env.onProgress?.(`Index as folder: ${options.indexAsFolder}`);
  if (options.skipUnchanged) {
    env.onProgress?.('Skipping files unchanged since their last sync');
  }

  const relativePaths = files.map((f) => f.relativePath ?? f.path);
  const tree = buildDocumentTree(relativePaths, {
    indexAsFolder: options.indexAsFolder,
  });

  const contentMap = new Map<string, string>();
  for (const fd of files) {
    const key = fd.relativePath ?? fd.path;
    contentMap.set(key, await env.readFile(fd));
  }
  const filesWithContent = files.map((fd) => ({
    path: fd.relativePath ?? fd.path,
    content: contentMap.get(fd.relativePath ?? fd.path)!,
  }));
  const wikiResolver = env.getWikiResolver(filesWithContent);

  const fdByRelativePath = new Map<string, (typeof files)[0]>();
  for (const fd of files) {
    fdByRelativePath.set(fd.relativePath ?? fd.path, fd);
  }

  const result: SyncResult = { success: 0, failed: 0, skipped: 0, total: files.length };

  const pass1Options: SyncOptions = { ...options, preserveUnresolved: true };
  const envWithResolver: SyncEnv = {
    ...env,
    getWikiResolver: () => wikiResolver,
  };

  const syncedDocs: { title: string; documentId: string; finalMarkdown: string }[] = [];

  async function syncNode(
    node: DocNode,
    parentDocumentId: string | undefined,
    depth: number
  ): Promise<void> {
    const indent = '  '.repeat(depth);
    const prefix = node.isFolder ? '[D] ' : '';
    let nextParentId = parentDocumentId;

    if (node.filePath) {
      const fd = fdByRelativePath.get(node.filePath);
      if (fd) {
        const effectiveFd = node.isFolder ? { ...fd, basename: node.title } : fd;
        try {
          const res = await syncDocument(
            pass1Options,
            envWithResolver,
            effectiveFd,
            parentDocumentId
          );
          if (res) {
            nextParentId = res.documentId;
            if (res.action === 'skipped') result.skipped++;
            else result.success++;
            if (res.finalMarkdown) {
              syncedDocs.push({
                title: effectiveFd.basename,
                documentId: res.documentId,
                finalMarkdown: res.finalMarkdown,
              });
            }
            let detail = res.action;
            if (res.imageStats) {
              detail += ` (${res.imageStats.uploaded}/${res.imageStats.total} images)`;
            }
            env.onProgress?.(`${indent}${prefix}${node.title}… ${detail} ✓`);
          }
        } catch (e) {
          result.failed++;
          // The document may already exist on the server even though this
          // push failed -- syncDocument attaches its id for exactly this
          // case (the create/update succeeded, only the final content push
          // didn't). Without it, every child under this node would attach to
          // its grandparent instead for the rest of the run.
          const partial = (e as SyncPartialFailure).partialResult;
          if (partial) {
            nextParentId = partial.documentId;
          }
          const msg = getErrorMessage(e);
          env.onProgress?.(`${indent}${prefix}${node.title}… ✗ ${msg}`);
          console.error(`[Outline Sync] Failed to push "${fd.path}":`, e);
        }
      }
    } else if (node.isFolder && node.children.length > 0) {
      try {
        const indexKey = `${options.collectionId}:${node.relativePath}`;

        // Prefer the remembered id: search is eventually consistent and a miss
        // would create a second placeholder for the same folder.
        let existingId: string | null = null;
        const remembered = env.folderIndex?.get(indexKey);
        if (remembered) {
          const doc = await env.api.getDocument(remembered);
          if (doc?.id && doc.collectionId === options.collectionId) {
            existingId = doc.id;
          }
        }
        if (!existingId) {
          const found = await env.api.searchDocumentByTitle(
            node.title,
            options.collectionId,
            parentDocumentId
          );
          existingId = found?.id ?? null;
        }

        if (existingId) {
          nextParentId = existingId;
          await env.folderIndex?.set(indexKey, existingId);
          env.onProgress?.(`${indent}${prefix}${node.title}… exists ✓`);
        } else {
          const created = await env.api.createDocument({
            title: node.title,
            text: '',
            collectionId: options.collectionId,
            publish: true,
            parentDocumentId,
          });
          if (created?.id) {
            nextParentId = created.id;
            await env.folderIndex?.set(indexKey, created.id);
            env.onProgress?.(`${indent}${prefix}${node.title}… created ✓`);
          }
        }
      } catch (e) {
        const msg = getErrorMessage(e);
        env.onProgress?.(`${indent}${prefix}${node.title}… ✗ ${msg}`);
        console.error(`[Outline Sync] Failed to create folder "${node.title}":`, e);
      }
    }
    for (const child of node.children) {
      await syncNode(child, nextParentId, depth + 1);
    }
  }

  for (const root of tree) {
    await syncNode(root, undefined, 0);
  }

  // Pass 2: resolve any %%WIKILINK[target|display]%% markers left from pass 1.
  // Build a complete resolver that includes all newly created documents.
  const MARKER_RE = /%%WIKILINK\[/;
  const docsWithMarkers = syncedDocs.filter((d) => MARKER_RE.test(d.finalMarkdown));

  if (docsWithMarkers.length > 0) {
    const completeMap = new Map<string, string>();
    for (const d of syncedDocs) {
      completeMap.set(d.title, d.documentId);
    }
    const completeResolver = (target: string) =>
      wikiResolver(target) ?? completeMap.get(target) ?? null;

    env.onProgress?.('Resolving cross-references…');
    for (const doc of docsWithMarkers) {
      const resolved = resolveWikiLinkMarkers(
        doc.finalMarkdown,
        completeResolver,
        options.outlineUrl
      );
      if (resolved !== doc.finalMarkdown) {
        try {
          await env.api.updateDocument({
            id: doc.documentId,
            title: doc.title,
            text: resolved,
            publish: true,
          });
          env.onProgress?.(`  ${doc.title}… links updated ✓`);
        } catch (e) {
          const msg = getErrorMessage(e);
          env.onProgress?.(`  ${doc.title}… link update ✗ ${msg}`);
        }
      }
    }
  }

  return result;
}
