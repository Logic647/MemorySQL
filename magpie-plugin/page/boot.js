// 「带路页」：magpie 的插件页面是 sandbox 框架，connect-src 'none'，
// 不能直接 fetch。这里只做两件事：接住 agent 行菜单的 action，然后把
// 框架导航到插件自己的本地服务（真正的 UI 在那里）。
(async () => {
  let agent = ''
  try {
    await magpie.ready
    if (typeof magpie.onAction === 'function') {
      magpie.onAction((action) => {
        if (action?.agent?.id) agent = String(action.agent.id)
      })
    }
    const options = await magpie.options.get().catch(() => ({}))
    const port = Number(options?.pagePort) || 3488
    // action 在页面 hello 之后才投递；没点菜单项时也不至于等太久
    if (!agent) await new Promise((resolve) => setTimeout(resolve, 500))
    // magpie web 里 127.0.0.1 是浏览器自己的电脑：优先用桥接给的服务地址
    const raw =
      typeof magpie.service === 'string' && magpie.service
        ? magpie.service
        : `http://127.0.0.1:${port}/`
    let base = raw
    try {
      base = new URL(raw, location.href).href
    } catch {
      /* 保留原值 */
    }
    if (!base.endsWith('/')) base += '/'
    const query = agent ? `?agent=${encodeURIComponent(agent)}` : ''
    location.replace(`${base}${query}`)
  } catch {
    location.replace('http://127.0.0.1:3488/')
  }
})()
