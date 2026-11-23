# Scanner

`scanner-worker.js`, started by `main.js` with `workerData.roots`.

## Roots
- All drives: Windows → every existing `A:\`..`Z:\`; Linux → `/`.
- Folder: the chosen folder (resolved).

## Walk
Iterative stack + async `fs.promises.readdir(dir, {withFileTypes:true})`. Symlinks are not followed (Dirent is neither dir nor file). Matching files are `stat`ed (size, mtime). Errors (EPERM/EACCES/ENOENT) are ignored. Office lock files (`~$*`) are skipped.

## Skip rules (checked for child directories, not the chosen root)
- Windows (lowercased, drive stripped): `\windows`, `\program files`, `\program files (x86)`, `\programdata`, names `$recycle.bin`, `system volume information`, `node_modules`, `.git`, path suffix `\appdata\local\temp`.
- Linux: `/proc /sys /dev /run /usr /bin /sbin /lib /lib32 /lib64 /boot`, names `node_modules`, `.git`.

## Messages (worker → main)
`{type:'batch', files}` (≥500), `{type:'progress', found, folder}` (throttled 100ms), `{type:'done', stopped, found}`, `{type:'error', message}`.
Main → worker: `'stop'` (sets a flag checked per directory; remaining batch is flushed, then `done` with `stopped:true`).
The worker closes `parentPort` after `done` so the thread exits.
