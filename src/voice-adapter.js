// A conexão de voz precisa dos dois eventos do gateway, usando a sessão do bot.
function makeAdapterCreator(discord, guildId, diagnostics = {}) {
  return (methods) => {
    let hasState = false;
    let pendingServer = null;
    let destroyed = false;

    const onState = (data) => {
      if (destroyed || data.guild_id !== guildId || data.user_id !== discord.me?.id) return;
      diagnostics.stateReceived = true;
      if (!data.channel_id) {
        methods.destroy();
        return;
      }
      methods.onVoiceStateUpdate(data);
      hasState = true;
      // @discordjs/voice configura a conexão ao receber o evento do servidor.
      // Se ele chegou primeiro, só o entregamos após o estado do próprio bot.
      if (pendingServer) {
        const server = pendingServer;
        pendingServer = null;
        methods.onVoiceServerUpdate(server);
      }
    };
    const onServer = (data) => {
      if (destroyed || data.guild_id !== guildId) return;
      diagnostics.serverReceived = true;
      if (hasState) methods.onVoiceServerUpdate(data);
      else pendingServer = data;
    };
    discord.on('voiceStateUpdate', onState);
    discord.on('voiceServerUpdate', onServer);

    return {
      sendPayload(payload) {
        if (destroyed) return false;
        if (payload.op === 4 && payload.d?.channel_id) {
          hasState = false;
          pendingServer = null;
        }
        const sent = discord.send(payload.op, payload.d);
        if (payload.op === 4 && payload.d?.channel_id) diagnostics.gatewaySent = sent;
        return sent;
      },
      destroy() {
        destroyed = true;
        discord.off('voiceStateUpdate', onState);
        discord.off('voiceServerUpdate', onServer);
        pendingServer = null;
      }
    };
  };
}

module.exports = { makeAdapterCreator };
