/** 只依赖 HTTP 的 CustomController 适配器；不持有任务、帧路径或判据。 */
export function remoteFramesActor(url: string, token: string): maa.CustomControllerActor {
  const call = async (operation: string, args: unknown[]): Promise<Response> => {
    const response = await fetch(url + '/v1/' + operation, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    })
    if (!response.ok) throw new Error('device request failed: ' + response.status)
    return response
  }
  return {
    connect: () => true,
    request_uuid: () => 'custom-ctrl-0001',
    get_features: () => [],
    get_info: () => JSON.stringify({ type: 'custom' }),
    screencap: async () => (await call('screencap', [])).arrayBuffer(),
    click: async (x, y) => (await call('click', [x, y])).json() as Promise<boolean>,
    swipe: async (x1, y1, x2, y2, duration) =>
      (await call('swipe', [x1, y1, x2, y2, duration])).json() as Promise<boolean>,
    shell: async (command, timeout) => (await call('shell', [command, timeout])).json() as Promise<null>,
    inactive: () => true,
  }
}
