import { handleChatAppRequest } from "./app.js";

export class ChatCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const user = {
      email: request.headers.get("x-chat-user-email") ?? "",
      subject: request.headers.get("x-chat-user-subject") ?? "",
    };

    return handleChatAppRequest(request, this.env, user);
  }
}
