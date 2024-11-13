import 'cross-fetch/dist/node-polyfill.js'
import eventsource from 'eventsource'

import PocketBase from 'pocketbase'
import { Context, Telegraf } from 'telegraf'

globalThis.EventSource = eventsource as any

interface Settings {
  bot_token?: string
  chat_id?: string
  admin?: string
}

const PARTICIPANTS_COLLECTION = 'participants'
const SETTINGS_COLLECTION = 'settings'
const ALL = '*'
const FILTER_ACTIVE_AND_NOT_DISABLED_USERS = 'active=true && disabled=false'
const BY_TELEGRAM_ID = (telegramId: number) => `telegram_id=${telegramId}`
const START_MESSAGE = 'welcome aboard'
const STOP_MESSAGE = 'see you soon'
const BLOCKED_MESSAGE = ':-/'
const START_COMMAND = 'start'
const STOP_COMMAND = 'stop'
const MESSAGE_EVENT = 'message'
const EMPTY_TOKEN_ERROR = 'Bot token is empty'
const SIGINT = 'SIGINT'
const SIGTERM = 'SIGTERM'

const token = process.env.TOKEN
const pb = new PocketBase(process.env.PB)

const getSettings = (() => {
  const update = async () => {
    const settings = {}
    const result = await pb.collection(SETTINGS_COLLECTION).getFullList({ query: { token } })

    result.forEach(row => {
      settings[row.key] = row.value
    })

    return settings
  }

  let promise = update()

  pb.collection(SETTINGS_COLLECTION).subscribe(ALL, () => {
    promise = update()
  })

  return () => promise as Promise<Settings>
})()

const getUsers = (() => {
  const update = async () => {
    const users: number[] = []
    const result = await pb.collection(PARTICIPANTS_COLLECTION).getFullList({
      filter: FILTER_ACTIVE_AND_NOT_DISABLED_USERS,
      query: { token }
    })

    result.forEach(row => {
      users.push(row.telegram_id)
    })

    return users
  }

  let promise = update()

  pb.collection(PARTICIPANTS_COLLECTION).subscribe(ALL, () => {
    promise = update()
  })

  return () => promise as Promise<number[]>
})()

const getUser = async (telegramId: number) => {
  try {
    return await pb.collection(PARTICIPANTS_COLLECTION).getFirstListItem(
      BY_TELEGRAM_ID(telegramId),
      { query: { token },
    })
  } catch (_e) {}
}

const setUserActive = async (userId: string) => {
  return await pb.collection(PARTICIPANTS_COLLECTION).update(
    userId,
    { active: true },
    { query: { token },
  })
}

const setUserInactive = async (userId: string) => {
  return await pb.collection(PARTICIPANTS_COLLECTION).update(
    userId,
    { active: false },
    { query: { token },
  })
}

const createUser = async (telegramId: number) => {
  return await pb.collection(PARTICIPANTS_COLLECTION).create(
    {
      telegram_id: telegramId,
      active: true,
    },
    { query: { token },
  })
}

const isBlockedUser = async (telegramId: number) => {
  const user = await getUser(telegramId)

  if (!user) {
    await createUser(telegramId)
    return false
  }

  return user.disabled
}

const isPrivateChat = (ctx: Context) => {
  return (ctx.message?.from.id === ctx.message?.chat.id)
}

const onStartCommand = async (ctx) => {
  if (!isPrivateChat(ctx)) {
    return
  }

  const telegramId = ctx.update.message.from.id

  if (await isBlockedUser(telegramId)) {
    return ctx.reply(BLOCKED_MESSAGE)
  }

  const user = await getUser(telegramId)

  if (user) {
    await setUserActive(user.id)
    await ctx.reply(START_MESSAGE)
  }
}

const onStopCommand = async (ctx) => {
  if (!isPrivateChat(ctx)) {
    return
  }

  const telegramId = ctx.update.message.from.id

  if (await isBlockedUser(telegramId)) {
    return ctx.reply(BLOCKED_MESSAGE)
  }

  const user = await getUser(telegramId)

  if (user) {
    await setUserInactive(user.id)
    await ctx.reply(STOP_MESSAGE)
  }
}

const onMessage = async (ctx) => {
  const settings = await getSettings()

  if (await isBlockedUser(ctx.update.message.from.id)) {
    return
  }

  if (ctx.update.message.chat.id === Number(settings.chat_id)) {
    const users = await getUsers()

    users.forEach(userId => {
      ctx.telegram.copyMessage(
        userId,
        settings.chat_id,
        ctx.update.message.message_id,
      )
    })
  } else if (ctx.update.message.chat.id === ctx.update.message.from.id) {
    ctx.telegram.copyMessage(
      settings.chat_id,
      ctx.update.message.chat.id,
      ctx.update.message.message_id,
    )
  }
}

const main = async () => {
  const settings = await getSettings()

  if (!settings.bot_token) {
    return console.log(EMPTY_TOKEN_ERROR)
  }

  const bot = new Telegraf(settings.bot_token)

  bot.command(START_COMMAND, onStartCommand)
  bot.command(STOP_COMMAND, onStopCommand)
  bot.on(MESSAGE_EVENT, onMessage)
  bot.launch()

  process.once(SIGINT, () => bot.stop(SIGINT))
  process.once(SIGTERM, () => bot.stop(SIGTERM))
}

main()
