# Email integration rules

- Existing IMAP/SMTP account settings include editable email and login plus a blank password field and Save and reconnect. Update the existing account ID and preserve cached folders and messages; credentials remain in host storage and are never read into the form or exposed as Workflow blocks.
- Credential presence and cached folder reads never prove a live connection. Show saved, missing, and unreadable credentials accurately, expose cache fallback warnings, and test IMAP/SMTP authentication without fetching or sending messages.
- MIME parsing must yield within large messages and decode compact typed-array views in the isolated guest. Verify a large synthetic message under the unchanged CPU guard before deploying parser changes.
- MIME parsing compacts each line before decoder calls and yields within a single message. Preserve byte/nesting limits and the host CPU guard; verify synthetic large MIME in a disposable guest when changing the pinned parser or scheduling hook. Initial automatic sync waits until registration settles and runs in a later turn.
