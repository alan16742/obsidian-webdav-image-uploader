# WebDAV Image Uploader

This is an Obsidian (https://obsidian.md) plugin for managing local images by storing them on WebDAV server, and previewing them via links (`![]()`):

![sample](./assets/sample.gif)

## Features

### Upload, Download, and Delete Files

- When pasting or dragging images into a note, the plugin selects the first matching upload rule and uploads to its WebDAV storage path. With **Use logical attachment links** enabled, it inserts a logical link such as `![](../Attachments/photo.jpg)` or `![[Attachments/photo.jpg]]`. With the switch disabled, it inserts the final preview URL, such as `![](https://img.example.com/Pictures/photo.jpg)`. Auto upload can be toggled in settings or using `WebDAV Image Uploader: Toggle auto upload`.
- **Use logical attachment links** also allows uploading existing local links (`![file](attachments/file.jpg)`, `[](attachments/file.jpg)`, or `[[file.jpg]]`) through the context menu and batch commands. The source link is resolved to the actual vault file, then the upload rules render a new target; the source path is not reused as `logicalPath`. You can configure whether to keep the local file after a successful upload. The switch defaults to disabled (URL links).
- When right-clicking a managed attachment link, you can select `Download file from WebDAV` to download to its logical vault path. An existing local file is retained.
- When right-clicking a preview link, you can select `Delete file from WebDAV` to delete the image from the WebDAV server and remove the link from the note.
- When right-clicking a preview link, you can select `Rename file from WebDAV` to rename(move) the image from the WebDAV server.

### Batch Upload/Download

In the Plugin Settings -> Commands, some buttons are provided for batch uploading and downloading images:

- Read all notes in the vault, and upload all local images (`![file](attachments/file.jpg)`) to the WebDAV server.
- Read all notes in the vault, and download missing logical attachments or managed remote URL links to their logical vault paths. Existing local attachments are skipped.

In the file explorer, you can:

- Right-click on a file, and upload/download all images in this file to/from WebDAV.
- Right-click on a folder(attachment folder), and upload all images in this folder to WebDAV.
- Right-click on a folder, and upload/download all images in this folder's notes to/from WebDAV (including subfolders).

### Batch Process Log

After performing batch upload/download operations, a log file named `webdav-batch-log-<timestamp>.md` will be created in the vault's root directory. This log file records successful, skipped, and failed files, including files skipped because no upload rule matched. You can enable/disable this feature in the plugin settings.

**Note: These batch process features have not been thoroughly tested (only run once in my vault). Please be sure to back up your vault before running them to prevent damage due to bugs.**

### Dummy PDF

When both **Use logical attachment links** and **Enable dummy PDF** are enabled, the plugin creates a [Dummy PDF](https://ryotaushio.github.io/obsidian-pdf-plus/external-pdf-files.html) after uploading a PDF, allowing [PDF++](https://github.com/RyotaUshio/obsidian-pdf-plus) to preview the remote file. In URL mode, new PDF uploads insert the preview URL directly. Existing dummy PDFs can still be downloaded, renamed, or deleted in either mode. (Thanks the idea from [here](https://github.com/Koishiiko/obsidian-webdav-image-uploader/issues/6))

More details about the new features can be found in the [Release Page](https://github.com/Koishiiko/obsidian-webdav-image-uploader/releases).

### Upload Rules

Rules are checked from top to bottom. The first rule whose filename prefix, filename suffix, and extensions all match is used. Empty prefix and suffix match any filename. **Any extension** makes the extension condition a wildcard. Unmatched files are skipped.

The **WebDAV connection URL** at the top of settings is only the server connection. Each rule has three independent templates:

| Field | Purpose | Default |
| --- | --- | --- |
| `logicalPath` | Vault-relative target for downloads and logical links | `{{attachment}}/{{nameext}}` |
| `remotePath` | Actual storage path used by every DAV operation | `{{logicalPath}}` |
| `previewUrl` | Final remote preview URL, used in URL mode | `{{url}}/{{remotePath}}` |

For an existing attachment, `{{attachment}}` is the source file's parent folder. For a new pasted or dropped file, it is Obsidian's configured attachment folder for the current note.

For example:

```json
{
  "prefix": "",
  "suffix": "",
  "extensions": ["jpg", "jpeg", "png", "gif", "svg", "webp"],
  "logicalPath": "{{attachment}}/pics/{{nameext}}",
  "remotePath": "{{logicalPath}}",
  "previewUrl": "https://example.com/p/od/{{remotePath}}"
}
```

For an existing file at `attachments/obassets/a.png`, referenced as `../attachments/obassets/a.png` or `[[a.png]]`, this rule produces:

- `logicalPath`: `attachments/obassets/pics/a.png`
- `remotePath`: `attachments/obassets/pics/a.png`
- `previewUrl`: `https://example.com/p/od/attachments/obassets/pics/a.png`
- note target: the new logical path in the configured link format, or the preview URL in URL mode

Uploading does not move the local source file. The note receives the new target, then **Uploaded file operation** decides whether the source file is kept, trashed, or deleted.

All templates share the variables `url`, `logicalPath`, `remotePath`, `attachment`, `name`, `ext`, `nameext`, `mtime`, `now`, `notename`, `notectime`, and `notemtime`. `{{url}}` is the WebDAV connection URL. Path references resolve by dependency, including forward references. Date variables and Moment.js formats such as `{{now:YYYY}}` are allowed only in `logicalPath`, where the upload-time value is frozen in the note. `remotePath` and `previewUrl` omit these variables from their menus and reject them; derive stable values from `{{logicalPath}}` instead. Unknown values, circular references, and invalid templates fail explicitly. Empty fields use the defaults above, and the rule preview shows the note target for the selected mode.

Links are resolved from the current note and ordered rules; no path mapping is persisted. A full logical link supplies its path directly. A shortest link uses `{{attachment}}` from the note context for the directory and keeps its filename, so `[[a.png]]` maps reproducibly without stored history. Changing rules or their order can change how existing links resolve, so storage templates should remain stable.

For logical links, local files take precedence; missing targets are reconstructed from the note context and their preview URL. Existing logical links continue to work in URL mode. Uploads do not create WebDAV-shaped vault directories. Downloads create only the logical destination's parent directories and replace the note target with a local link. Shortest links use the filename alone; other Wikilink modes use the full logical path. Changing modes affects new uploads and renames, not existing notes.

Rename accepts a **logical vault path** in logical mode and an **actual DAV path** in URL mode. The result always retains a logical download destination. Every DAV operation uses `remotePath` and the connection URL; preview URLs are never sent to WebDAV. Blob caches are keyed by DAV destination and invalidated after upload, rename, and delete.

## Others

### About Media Preview

WebDAV may require [HTTP Authentication](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Authentication) to verify permissions when accessing files. Obsidian does not provide an API to add authentication headers to media requests sent by `![]()`. In Live Preview and Reading view, this plugin downloads managed images, videos, and audio files through the configured WebDAV server using their mapped remote paths and displays them with temporary blob URLs. WebDAV credentials are only sent to the connection URL. When authentication proxying is disabled, missing local attachments display their final preview URLs directly.

Remote audio and video links are rendered as native media controls even when Obsidian initially creates an image preview for them. If a local Markdown or Wikilink media embed cannot be found in the vault, the plugin also tries the same path on WebDAV when its filename matches an upload rule. Existing local attachments keep using Obsidian's native renderer.

Blob-backed video and audio must be downloaded completely before playback and cannot use HTTP range streaming. For large media files, prefer public or signed media URLs and disable this feature in the plugin settings. You can configure your server to allow media access for Obsidian requests using the following headers:

```http

# desktop app
User-Agent: obsidian/x.x.x

# mobile app
X-Requested-With: md.obsidian
```

So we can identify these requests in Nginx like this:

```nginx
# concat the headers and match "obsidian", return the token if matched
map "$http_user_agent|$http_x_requested_with" $obsidian_header {
    default $http_authorization;
    # generate your token by encoding "username:password" in base64 format:
    # $> echo -n "username:password" | base64
    "~*obsidian" "Basic {TOKEN}";
}

server {
    # ...
    location /obsidian {
        proxy_set_header Authorization $obsidian_header;
        # ...
    }
}
```

Then you don't need to use this plugin's account settings and the preview feature. If you have a better solution, pull requests are welcome.

### About This Plugin

This plugin was primarily written for my personal use to replace the [image-auto-upload](https://github.com/renmu123/obsidian-image-auto-upload-plugin) plugin, due to it requires running an additional `PicGo` locally, and it does not offer a feature to upload images for the entire vault (I have thousands of notes needs to process).

After trying my plugin out for a few days, I feel that it already meets my needs: uploading all images to WebDAV (even though it only ran once), and then easily uploading and downloading images within notes (with the ability to conveniently delete them when something goes wrong).

## Inspired by

[obsidian-image-auto-upload-plugin](https://github.com/renmu123/obsidian-image-auto-upload-plugin)
