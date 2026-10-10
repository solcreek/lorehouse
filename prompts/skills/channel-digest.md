---
name: channel-digest
description: Summarize what has been discussed lately across the channels you read, as a report grouped by topic
when-to-use: someone asks what has been discussed recently, for a recap or digest, or to 彙整最近的議題
---
Report what the company has been discussing lately, in one consistent shape, so people can
compare one digest with the next.

1. Call `recent_knowledge` with `limit: 30`. For a period counted back from today ("this
   week", "the last 14 days"), also pass `days`. For a calendar period ("since August"),
   leave `days` out and keep only the threads whose `activeAt` falls in it, reading the
   current date from the `now` the tool returns. If a `days` call returns no threads, call
   again without `days` to learn the date of the newest thread. The tool returns at most 30
   threads, newest first. When it returns all 30 and the period starts before the oldest
   of them, say the report reaches back only to that thread's date; if the whole period is
   older, say it is out of reach, not that it was quiet.
2. Each result holds only the start of a thread. When a thread looks central and is cut off,
   read all of it with `slack_read_thread`. A result's id is `slack:<channelId>:<threadId>`.
   Your own replies and the questions people put to you in that thread are not what people
   discussed: leave them out. If it refuses the channel, work from the excerpt.
3. Group the threads into topics by what they are about, not by channel or date: as many
   topics as the threads honestly hold, at most 6. One or two threads may make only one or
   two topics; never split a thread or invent a topic to reach a number. Put each thread
   under one topic only. Order the topics by how many threads they hold.
4. Write the report in the language of the question, in this shape:

   - First line: the dates the threads were last active (the oldest and newest `activeAt`)
     and how many topics follow. When there are only one or two, say plainly that
     the period held few topics, and how many threads.
   - One numbered section per topic. Its title is bold: the topic, then a few words on its
     gist. Under it, one to four sentences: who said or decided what, and what happens next.
     Put each claim's thread link (the result's `source`) right after it, with the link
     text "thread". Cite with these links, not with chunk ids.
   - Threads that fit no topic go last, under "Other", one bullet each with its link.
   - One closing sentence that states the main line running through the topics.
   - One short question offering to dig into a topic.

Rules:
- Say only what the threads say. Every claim carries its thread link. If a detail is not in
  what you read, leave it out rather than guess.
- Name people as the knowledge does, crediting each message to the person on its line.
- If nothing falls in the period asked for, say so and give the date of the newest thread.
