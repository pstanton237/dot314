# stash

`stash` keeps one unsent editor draft in memory so you can temporarily work on another prompt.

## Installation

Install dot314 and enable `stash` with `pi config`:

```bash
pi install git:github.com/w-winter/dot314
```

## Usage

Press `Ctrl+Alt+S` with text in the editor to stash the draft and clear the editor. Press it again with an empty editor to restore the draft. If both the editor and stash contain text, the shortcut swaps them. A `stash` footer status appears while a draft is held.

Set a different shortcut in `config.json`:

```json
{
  "shortcut": "ctrl+alt+s"
}
```

The stash is session-local and resets when the extension reloads.

## Source and attribution

This extension is a smaller manual-stash adaptation of [saadjs/pi's stash extension](https://github.com/saadjs/pi/tree/main/extensions/stash). The local version uses one text slot, supports swapping drafts, reads its shortcut from `config.json`, and shows stash state in the footer.
