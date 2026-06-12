import { handleChatAppRequest } from "./app.js";

export class ChatCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.queue = Promise.resolve();
  }

  async fetch(request) {
    const run = this.queue.then(
      () => this.handle(request),
      () => this.handle(request),
    );
    this.queue = run.catch(() => {});
    return run;
  }

  async handle(request) {
    const user = {
      email: request.headers.get("x-chat-user-email") ?? "",
      subject: request.headers.get("x-chat-user-subject") ?? "",
    };

    return handleChatAppRequest(request, this.env, user);
  }
}
