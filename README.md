# WebDAV Image Uploader

This is an Obsidian (https://obsidian.md) plugin for managing local images by storing them on WebDAV server, and previewing them via links (`![]()`):

![sample](./assets/sample.gif)

## Features

### Upload, Download, and Delete Files

- When pasting or dragging images into a note, the plugin will intercept the action, select the first matching upload rule, upload the image to the corresponding WebDAV path, and insert the generated preview link (`![file](https://yourdomain.com/dav/path/to/file.jpg)`). You can enable/disable it in the plugin settings, or execute `WebDAV Image Uploader: Toggle auto upload` command.
- You can also right-click on a local image link (`![file](attachments/file.jpg)`) and select the `Upload file to WebDAV` option from the menu to upload the image and insert the link. You can configure whether to keep the local file after a successful upload.
- When right-clicking a preview link, you can select `Download file from WebDAV` to download the image locally. The path is related to your Obsidian configuration (Settings -> Files & Links).
- When right-clicking a preview link, you can select `Delete file from WebDAV` to delete the image from the WebDAV server and remove the link from the note.
- When right-clicking a preview link, you can select `Rename file from WebDAV` to rename(move) the image from the WebDAV server.

### Batch Upload/Download

In the Plugin Settings -> Commands, some buttons are provided for batch uploading and downloading images:

- Read all notes in the vault, and upload all local images (`![file](attachments/file.jpg)`) to the WebDAV server.
- Read all notes in the vault, and download all remote images (`![file](https://yourdomain.com/dav/...)`) to locally.

In the file explorer, you can:

- Right-click on a file, and upload/download all images in this file to/from WebDAV.
- Right-click on a folder(attachment folder), and upload all images in this folder to WebDAV.
- Right-click on a folder, and upload/download all images in this folder's notes to/from WebDAV (including subfolders).

### Batch Process Log

After performing batch upload/download operations, a log file named `webdav-batch-log-<timestamp>.md` will be created in the vault's root directory. This log file records successful, skipped, and failed files, including files skipped because no upload rule matched. You can enable/disable this feature in the plugin settings.

**Note: These batch process features have not been thoroughly tested (only run once in my vault). Please be sure to back up your vault before running them to prevent damage due to bugs.**

### Dummy PDF

When `Settings -> Enable Dummy PDF` is enabled, the plugin will create a [Dummy PDF](https://ryotaushio.github.io/obsidian-pdf-plus/external-pdf-files.html) file after PDF file is uploaded, then you can preview the PDFs stored on WebDAV server by [PDF++](https://github.com/RyotaUshio/obsidian-pdf-plus) plugin. You can also upload/download/delete PDF files in the same way as other files. (Thanks the idea from [here](https://github.com/Koishiiko/obsidian-webdav-image-uploader/issues/6))

More details about the new features can be found in the [Release Page](https://github.com/Koishiiko/obsidian-webdav-image-uploader/releases).

### Upload Rules

Upload rules combine file filtering, public URL selection, and path formatting. Rules are checked from top to bottom, and the first rule whose configured filename prefix, filename suffix, and extensions all match is used. Empty prefix and suffix fields match any filename. Enabling **Any extension** makes the extension condition a wildcard. Files that do not match a rule are skipped.

Each rule has a URL prefix and a link format. A blank URL prefix uses the main WebDAV URL. The link format must start with `{{url}}` and produces the complete link inserted into the note. For example:

```text
URL prefix:  https://img.example.com
Link format: {{url}}/images/{{nameext}}
Result:      https://img.example.com/images/photo.jpg
```

The public URL prefix must map paths one-to-one to the main WebDAV server. WebDAV upload, download, rename, and delete requests always use the main WebDAV URL; public URL prefixes are only used in note links.

## Others

### About Image Preview

WebDAV may require [Http Authentication](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Authentication) to verify permissions when accessing files. But Obsidian (CodeMirror) does not seem to provide an API to add request headers for requests sent by `![]()`. Therefore, this plugin manually fetching and displaying the images. This display behavior differs from Obsidian's default behavior and may result in loading failures (in rare cases), and it doesn't work in other cases (like reading mode or [image properties](https://help.obsidian.md/bases/views#Image+property)).

If you don't like this feature, you can disable it in the plugin settings (and restart Obsidian), then configure your server to allow image access (or simply disable authentication). For example, you can identify Obsidian's requests using the following headers:

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
