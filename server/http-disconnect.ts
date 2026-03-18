import type express from 'express';

interface ClientDisconnectBinding {
  isDisconnected: () => boolean;
}

export function bindClientDisconnect(
  req: express.Request,
  res: express.Response,
  onDisconnect: () => void,
): ClientDisconnectBinding {
  let disconnected = false;

  const handleDisconnect = () => {
    if (disconnected) {
      return;
    }
    disconnected = true;
    onDisconnect();
  };

  const handleResponseClose = () => {
    if (!res.writableEnded) {
      handleDisconnect();
    }
  };

  req.on('aborted', handleDisconnect);
  res.on('close', handleResponseClose);

  return {
    isDisconnected: () => disconnected,
  };
}
