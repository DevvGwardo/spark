const fs = require('fs');
let code = fs.readFileSync('src/test/chat-handoff.test.ts', 'utf8');

code = code.replace(/await onFinish\?\.\(\s*(\{[\s\S]*?\})\s*,\s*\{\s*finishReason:\s*('[^']+')\s*\},?\s*\);/g, "await onFinish?.({ message: $1 as any, finishReason: $2 } as any);");
code = code.replace(/await onFinish\?\.\(undefined,\s*\{\s*finishReason:\s*('[^']+')\s*\}\s*\);/g, "await onFinish?.({ message: undefined as any, finishReason: $1 } as any);");
code = code.replace(/await onFinish\?\.\(stopMessage,\s*\{\s*finishReason:\s*('[^']+')\s*\}\s*\);/g, "await onFinish?.({ message: stopMessage as any, finishReason: $1 } as any);");

fs.writeFileSync('src/test/chat-handoff.test.ts', code);
console.log('Done');
