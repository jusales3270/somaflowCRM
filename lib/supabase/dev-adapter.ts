/**
 * Dev Fetch Adapter para Supabase em Desenvolvimento Local.
 *
 * Elimina os timeouts de DNS/rede (7-30s) e erros 500 quando rodando em localhost
 * sem um servidor Supabase / Postgres ativo. Responde instantaneamente (0ms) com
 * dados representativos para o SomaFlow CRM.
 */

export function isDevSupabaseFallbackActive(): boolean {
  if (process.env.NODE_ENV !== "development") return false;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  return url.includes("somaflow-local") || process.env.USE_DEV_FALLBACK === "true";
}

const ORG_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000001";

const DEMO_DATA: Record<string, any[]> = {
  organizations: [
    {
      id: ORG_ID,
      name: "SomaFlow CRM",
      slug: "somaflow",
      legal_name: "SomaFlow Tecnologia Ltda",
      settings: {
        branding: {
          app_name: "SomaFlow CRM",
        },
      },
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-05T00:00:00.000Z",
    },
  ],
  user_organizations: [
    {
      user_id: USER_ID,
      organization_id: ORG_ID,
      role: "admin",
      accepted_at: "2026-09-01T00:00:00.000Z",
      organizations: {
        display_name: "SomaFlow CRM",
        locale: "pt-BR",
      },
    },
  ],
  platform_admins: [
    {
      user_id: USER_ID,
      revoked_at: null,
      created_at: "2026-09-01T00:00:00.000Z",
    },
  ],
  ai_agents: [
    {
      id: "agent-sdr-01",
      organization_id: ORG_ID,
      name: "Agente SDR SomaFlow",
      slug: "sdr-somaflow",
      status: "published",
      is_active: true,
      created_at: "2026-09-01T10:00:00.000Z",
      updated_at: "2026-09-04T12:00:00.000Z",
      ai_agent_versions: {
        version: 1,
        model: "claude-3-5-sonnet-20241022",
        system_prompt: "Você é o atendente comercial e qualificador de leads do SomaFlow CRM.",
        created_at: "2026-09-01T10:00:00.000Z",
      },
    },
    {
      id: "agent-suporte-02",
      organization_id: ORG_ID,
      name: "Assistente de Suporte e Pós-Venda",
      slug: "suporte-somaflow",
      status: "published",
      is_active: true,
      created_at: "2026-09-02T14:00:00.000Z",
      updated_at: "2026-09-04T15:00:00.000Z",
      ai_agent_versions: {
        version: 1,
        model: "claude-3-5-sonnet-20241022",
        system_prompt: "Você tira dúvidas frequentes e atende clientes no pós-venda.",
        created_at: "2026-09-02T14:00:00.000Z",
      },
    },
  ],
  ai_agent_versions: [
    {
      id: "ver-01",
      agent_id: "agent-sdr-01",
      version: 1,
      model: "claude-3-5-sonnet-20241022",
      system_prompt: "Você é o atendente comercial do SomaFlow CRM.",
      is_published: true,
      created_at: "2026-09-01T10:00:00.000Z",
    },
  ],
  ai_routers: [
    {
      id: "router-01",
      organization_id: ORG_ID,
      name: "Roteador Principal WhatsApp",
      slug: "roteador-principal",
      is_active: true,
      created_at: "2026-09-01T00:00:00.000Z",
    },
  ],
  crm_pipelines: [
    {
      id: "pipe-01",
      organization_id: ORG_ID,
      name: "Funil Comercial Principal",
      slug: "comercial",
      description: "Funil de vendas consultivas e qualificação de novos leads",
      position: 0,
      is_default: true,
      is_archived: false,
      settings: {
        canonical_tags: ["Importante"],
      },
    },
  ],
  crm_stages: [
    { id: "stage-01", pipeline_id: "pipe-01", name: "Novos Leads", position: 0, color: "#3b82f6" },
    { id: "stage-02", pipeline_id: "pipe-01", name: "Qualificação", position: 1, color: "#eab308" },
    { id: "stage-03", pipeline_id: "pipe-01", name: "Apresentação / Demo", position: 2, color: "#a855f7" },
    { id: "stage-04", pipeline_id: "pipe-01", name: "Proposta Enviada", position: 3, color: "#f97316" },
    { id: "stage-05", pipeline_id: "pipe-01", name: "Fechado / Ganho", position: 4, color: "#22c55e" },
  ],
  contacts: [
    {
      id: "contact-01",
      organization_id: ORG_ID,
      name: "Renato Alcantara",
      display_name: "Renato Alcantara",
      phone: "+5511999991111",
      email: "renato@alcantara.com.br",
      created_at: "2026-09-02T10:00:00.000Z",
    },
    {
      id: "contact-02",
      organization_id: ORG_ID,
      name: "Juliana Martins",
      display_name: "Dra. Juliana Martins",
      phone: "+5511999992222",
      email: "juliana@clinica.com.br",
      created_at: "2026-09-03T11:00:00.000Z",
    },
    {
      id: "contact-03",
      organization_id: ORG_ID,
      name: "Marcos Andrade",
      display_name: "Marcos Andrade",
      phone: "+5511999993333",
      email: "marcos@solucoes.com.br",
      created_at: "2026-09-04T12:00:00.000Z",
    },
  ],
  crm_leads: [
    {
      id: "lead-01",
      title: "Renato Alcantara - Indústria ABC",
      organization_id: ORG_ID,
      pipeline_id: "pipe-01",
      stage_id: "stage-02",
      status: "open",
      value_cents: 150000,
      currency: "BRL",
      position_in_stage: 0,
      tags: ["Importante"],
      owner_kind: "user",
      owner_user_id: USER_ID,
      owner_agent_id: null,
      contact_id: "contact-01",
      contacts: {
        name: "Renato Alcantara",
        display_name: "Renato Alcantara",
        phone: "+5511999991111",
      },
      created_at: "2026-09-03T11:00:00.000Z",
      updated_at: "2026-09-04T17:30:00.000Z",
    },
    {
      id: "lead-02",
      title: "Juliana Martins - Clínica Bem Estar",
      organization_id: ORG_ID,
      pipeline_id: "pipe-01",
      stage_id: "stage-03",
      status: "open",
      value_cents: 320000,
      currency: "BRL",
      position_in_stage: 0,
      tags: ["Importante"],
      owner_kind: "user",
      owner_user_id: USER_ID,
      owner_agent_id: null,
      contact_id: "contact-02",
      contacts: {
        name: "Juliana Martins",
        display_name: "Dra. Juliana Martins",
        phone: "+5511999992222",
      },
      created_at: "2026-09-02T09:00:00.000Z",
      updated_at: "2026-09-04T18:00:00.000Z",
    },
    {
      id: "lead-03",
      title: "Marcos Andrade - Soluções TI",
      organization_id: ORG_ID,
      pipeline_id: "pipe-01",
      stage_id: "stage-04",
      status: "open",
      value_cents: 580000,
      currency: "BRL",
      position_in_stage: 0,
      tags: [],
      owner_kind: "user",
      owner_user_id: USER_ID,
      owner_agent_id: null,
      contact_id: "contact-03",
      contacts: {
        name: "Marcos Andrade",
        display_name: "Marcos Andrade",
        phone: "+5511999993333",
      },
      created_at: "2026-09-01T14:20:00.000Z",
      updated_at: "2026-09-04T19:10:00.000Z",
    },
  ],
  conversations: [
    {
      id: "conv-01",
      organization_id: ORG_ID,
      contact_id: "contact-01",
      status: "open",
      comando: "aguardando",
      unread_count: 1,
      last_message_at: "2026-09-05T00:10:00.000Z",
      last_message_preview: "Gostaria de agendar uma demonstração do SomaFlow para nossa equipe.",
      contacts: {
        name: "Renato Alcantara",
        display_name: "Renato Alcantara",
        phone: "+5511999991111",
      },
      tags: [],
      created_at: "2026-09-03T11:00:00.000Z",
    },
    {
      id: "conv-02",
      organization_id: ORG_ID,
      contact_id: "contact-02",
      status: "open",
      comando: "atendimento",
      unread_count: 0,
      last_message_at: "2026-09-04T22:30:00.000Z",
      last_message_preview: "Perfeito, recebemos a proposta e estamos analisando.",
      contacts: {
        name: "Juliana Martins",
        display_name: "Dra. Juliana Martins",
        phone: "+5511999992222",
      },
      tags: [],
      created_at: "2026-09-02T09:00:00.000Z",
    },
  ],
  channel_sessions: [
    {
      id: "chan-01",
      organization_id: ORG_ID,
      channel_type: "waha",
      name: "WhatsApp Comercial SomaFlow",
      status: "CONNECTED",
      phone_number: "+55 11 98888-7777",
      is_active: true,
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-05T00:00:00.000Z",
    },
  ],
  calendar_event_types: [
    {
      id: "event-type-01",
      organization_id: ORG_ID,
      name: "Demonstração do SomaFlow CRM",
      duration_minutes: 45,
      location_kind: "meet",
      location_details: "Google Meet",
      is_active: true,
      default_owner_user_id: USER_ID,
    },
    {
      id: "event-type-02",
      organization_id: ORG_ID,
      name: "Reunião de Proposta e Fechamento",
      duration_minutes: 30,
      location_kind: "whatsapp",
      location_details: "WhatsApp Call",
      is_active: true,
      default_owner_user_id: USER_ID,
    },
  ],
  calendar_appointments: [
    {
      id: "appt-01",
      organization_id: ORG_ID,
      title: "Demo SomaFlow CRM - Renato Alcantara",
      starts_at: new Date(Date.now() + 3600000 * 2).toISOString(),
      ends_at: new Date(Date.now() + 3600000 * 3).toISOString(),
      status: "confirmed",
      owner_user_id: USER_ID,
      contact_id: "contact-01",
      event_type_id: "event-type-01",
      location_kind: "meet",
      contacts: {
        name: "Renato Alcantara",
        display_name: "Renato Alcantara",
      },
    },
  ],
  conversation_tags: [
    { id: "tag-01", organization_id: ORG_ID, name: "Interesse Alto", color: "#22c55e" },
    { id: "tag-02", organization_id: ORG_ID, name: "Demonstração", color: "#3b82f6" },
    { id: "tag-03", organization_id: ORG_ID, name: "Proposta Enviada", color: "#f59e0b" },
  ],
  system_version: [
    {
      version: "1.14.0",
      database_version: "1.14.0",
      git_commit: "latest",
      built_at: "2026-09-05T00:00:00.000Z",
    },
  ],
};

export async function devSupabaseFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const parsed = new URL(urlStr, "http://localhost");
  const pathname = parsed.pathname;
  const method = (init?.method || "GET").toUpperCase();

  let accept = "";
  if (init?.headers) {
    if (typeof (init.headers as any).get === "function") {
      accept = (init.headers as any).get("accept") || "";
    } else {
      accept = (init.headers as any).Accept || (init.headers as any).accept || "";
    }
  }

  const isSingle = accept.includes("vnd.pgrst.object+json");

  // Auth endpoints
  if (pathname.startsWith("/auth/v1/user")) {
    return Response.json(
      {
        id: USER_ID,
        aud: "authenticated",
        role: "authenticated",
        email: "admin@somaflow.com",
        user_metadata: { full_name: "Administrador SomaFlow" },
      },
      { status: 200 },
    );
  }

  // RPC endpoints
  if (pathname.startsWith("/rest/v1/rpc/")) {
    const fnName = pathname.replace("/rest/v1/rpc/", "");
    if (fnName === "fn_user_role_in_org") {
      return Response.json("admin", { status: 200 });
    }
    if (fnName === "fn_is_platform_admin") {
      return Response.json(true, { status: 200 });
    }
    if (fnName === "fn_user_org_ids") {
      return Response.json([ORG_ID], { status: 200 });
    }
    return Response.json([], { status: 200 });
  }

  // REST endpoints
  if (pathname.startsWith("/rest/v1/")) {
    const tableWithParams = pathname.replace("/rest/v1/", "");
    const tableName = (tableWithParams.split("/")[0] ?? "").split("?")[0] ?? "";

    const list = DEMO_DATA[tableName] ?? [];

    if (method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Range": `0-${Math.max(0, list.length - 1)}/${list.length}`,
        },
      });
    }

    if (method === "GET") {
      let body: any = list;
      if (isSingle) {
        body = list[0] || {};
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Range": `0-${Math.max(0, list.length - 1)}/${list.length}`,
        },
      });
    }

    // Mutations (POST, PATCH, PUT, DELETE)
    const mockReturn = isSingle ? (list[0] || {}) : list;
    return new Response(JSON.stringify(mockReturn), {
      status: method === "POST" ? 201 : 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  return new Response(JSON.stringify([]), { status: 200 });
}
