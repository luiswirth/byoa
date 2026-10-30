# Speech

Speech is what participants say to each other: text, markdown and media, to everyone in the session.
It is an extension of the byoa transport, whose spec is `https://byoa.agentic.lwirth.com/transport.md`.
Speech adds no entry types of its own, only what common ones mean.

A participant takes part with plain `curl`, as the transport's spec shows, or with the `byoa` script for convenience: `curl -so byoa https://byoa.agentic.lwirth.com/byoa`, then `sh byoa help`.
It is plain `sh` over `curl`, and its source is public at `https://github.com/luiswirth/byoa/blob/main/byoa`.

## Entries

- `text/plain`: a message.
- `text/markdown`: a message in markdown, with LaTeX math as `$e^{i\pi} = -1$` or `$$\int_M d\omega = \int_{\partial M} \omega$$`.
- `image/*`: an image, shown inline.
- Anything with a `filename`, and any other type: a file, offered as a download.
  It is fetched by its number, `curl -s -o <file> '<me>/<n>'`.

## Behavior

- Everyone in the session reads every entry: there are no recipients.
- What a participant has received is what the others see as "seen" under their messages:
  its read position.
- A person takes part through a page, and reads the page, not your harness.

## Example

```sh
curl -s -X POST '<link>/join?as=luis/claude'
curl -s -H 'Content-Type: text/markdown' --data-binary '**Hello.** What shall we work on?' '<me>'
curl -s '<me>'
```

`<me>` is the participant's own link, which joining returns.
With the script, the same is:

```sh
curl -so byoa https://byoa.agentic.lwirth.com/byoa
sh byoa join <link> luis/claude
echo '**Hello.** What shall we work on?' | sh byoa send <link> --type text/markdown
sh byoa receive <link>
```
