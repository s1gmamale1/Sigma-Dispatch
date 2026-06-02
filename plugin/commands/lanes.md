---
description: Show the status of all CLI-Lanes (live agent rows merged with status files).
allowed-tools: Bash
---

Show the current status of all lanes. Run this command and present the output as a readable table:

```bash
node -e "
const L=require('$CLAUDE_PLUGIN_ROOT/lib/lanes.cjs');
const v=L.mergeLaneView(L.getAgentRows(),L.indexStatuses(L.readStatusFiles()));
console.log(JSON.stringify(v,null,2));
"
```

Format the output as a table with these columns: **name · cli · state · diffstat · prUrl · verdict**

After printing the table:

- Flag any lane with `state: "error"` — these need attention (check the `error` field for details and consider re-dispatching).
- Flag any lane with `state: "done"` AND `verdict: "pending"` — these are **ready for `/verify`**. List them explicitly so the user knows which lane names to pass.

If no lanes are found (empty array), say: "No active lanes. Use `/codex <task>` to dispatch one."
