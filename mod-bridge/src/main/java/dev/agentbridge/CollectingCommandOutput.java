package dev.agentbridge;

import net.minecraft.server.command.CommandOutput;
import net.minecraft.text.Text;

/**
 * A {@link CommandOutput} that appends everything a command prints into a {@link StringBuilder}
 * instead of broadcasting it into the server log / operator chat, so the HTTP caller can receive
 * the command's feedback as JSON.
 */
final class CollectingCommandOutput implements CommandOutput {
	private final StringBuilder sink;

	CollectingCommandOutput(StringBuilder sink) {
		this.sink = sink;
	}

	@Override
	public void sendMessage(Text message) {
		if (message == null) {
			return;
		}

		if (sink.length() > 0) {
			sink.append('\n');
		}

		sink.append(message.getString());
	}

	@Override
	public boolean shouldReceiveFeedback() {
		return true;
	}

	@Override
	public boolean shouldTrackOutput() {
		return true;
	}

	@Override
	public boolean shouldBroadcastConsoleToOps() {
		// The caller gets the output over HTTP; do not echo it to every operator in game.
		return false;
	}
}
