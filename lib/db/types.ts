// Hand-authored Database type matching supabase/migrations/20260531000000_init.sql
// Replace with `supabase gen types typescript` once the project is linked.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface Database {
  public: {
    Tables: {
      tenants: {
        Row: {
          id: string
          name: string
          default_locale: string
          rtl: boolean
          whatsapp_phone_number_id: string | null
          whatsapp_access_token: string | null
          printnode_printer_id: number | null
          stripe_customer_id: string | null
          subscription_status: string
          trial_ends_at: string
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          default_locale?: string
          rtl?: boolean
          whatsapp_phone_number_id?: string | null
          whatsapp_access_token?: string | null
          printnode_printer_id?: number | null
          stripe_customer_id?: string | null
          subscription_status?: string
          trial_ends_at?: string
          created_at?: string
        }
        Update: {
          id?: string
          name?: string
          default_locale?: string
          rtl?: boolean
          whatsapp_phone_number_id?: string | null
          whatsapp_access_token?: string | null
          printnode_printer_id?: number | null
          stripe_customer_id?: string | null
          subscription_status?: string
          trial_ends_at?: string
          created_at?: string
        }
        Relationships: []
      }
      users: {
        Row: {
          id: string
          tenant_id: string
          role: 'owner' | 'manager' | 'staff'
          full_name: string | null
          created_at: string
        }
        Insert: {
          id: string
          tenant_id: string
          role: 'owner' | 'manager' | 'staff'
          full_name?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          tenant_id?: string
          role?: 'owner' | 'manager' | 'staff'
          full_name?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'users_tenant_id_fkey'
            columns: ['tenant_id']
            isOneToOne: false
            referencedRelation: 'tenants'
            referencedColumns: ['id']
          },
        ]
      }
      menu_categories: {
        Row: {
          id: string
          tenant_id: string
          name: string
          sort_order: number
        }
        Insert: {
          id?: string
          tenant_id: string
          name: string
          sort_order?: number
        }
        Update: {
          id?: string
          tenant_id?: string
          name?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: 'menu_categories_tenant_id_fkey'
            columns: ['tenant_id']
            isOneToOne: false
            referencedRelation: 'tenants'
            referencedColumns: ['id']
          },
        ]
      }
      menu_items: {
        Row: {
          id: string
          tenant_id: string
          category_id: string | null
          name: string
          name_translations: Json
          description: string | null
          price_aed: number
          active: boolean
          aliases: string[]
          created_at: string
        }
        Insert: {
          id?: string
          tenant_id: string
          category_id?: string | null
          name: string
          name_translations?: Json
          description?: string | null
          price_aed: number
          active?: boolean
          aliases?: string[]
          created_at?: string
        }
        Update: {
          id?: string
          tenant_id?: string
          category_id?: string | null
          name?: string
          name_translations?: Json
          description?: string | null
          price_aed?: number
          active?: boolean
          aliases?: string[]
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'menu_items_tenant_id_fkey'
            columns: ['tenant_id']
            isOneToOne: false
            referencedRelation: 'tenants'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'menu_items_category_id_fkey'
            columns: ['category_id']
            isOneToOne: false
            referencedRelation: 'menu_categories'
            referencedColumns: ['id']
          },
        ]
      }
      menu_modifiers: {
        Row: {
          id: string
          tenant_id: string
          item_id: string
          name: string
          options: Json
          required: boolean
        }
        Insert: {
          id?: string
          tenant_id: string
          item_id: string
          name: string
          options: Json
          required?: boolean
        }
        Update: {
          id?: string
          tenant_id?: string
          item_id?: string
          name?: string
          options?: Json
          required?: boolean
        }
        Relationships: [
          {
            foreignKeyName: 'menu_modifiers_tenant_id_fkey'
            columns: ['tenant_id']
            isOneToOne: false
            referencedRelation: 'tenants'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'menu_modifiers_item_id_fkey'
            columns: ['item_id']
            isOneToOne: false
            referencedRelation: 'menu_items'
            referencedColumns: ['id']
          },
        ]
      }
      orders: {
        Row: {
          id: string
          tenant_id: string
          channel: Database['public']['Enums']['order_channel']
          status: Database['public']['Enums']['order_status']
          customer_name: string | null
          customer_phone: string | null
          table_label: string | null
          subtotal_aed: number
          total_aed: number
          raw_input: string | null
          parse_confidence: number | null
          created_at: string
        }
        Insert: {
          id?: string
          tenant_id: string
          channel: Database['public']['Enums']['order_channel']
          status?: Database['public']['Enums']['order_status']
          customer_name?: string | null
          customer_phone?: string | null
          table_label?: string | null
          subtotal_aed?: number
          total_aed?: number
          raw_input?: string | null
          parse_confidence?: number | null
          created_at?: string
        }
        Update: {
          id?: string
          tenant_id?: string
          channel?: Database['public']['Enums']['order_channel']
          status?: Database['public']['Enums']['order_status']
          customer_name?: string | null
          customer_phone?: string | null
          table_label?: string | null
          subtotal_aed?: number
          total_aed?: number
          raw_input?: string | null
          parse_confidence?: number | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'orders_tenant_id_fkey'
            columns: ['tenant_id']
            isOneToOne: false
            referencedRelation: 'tenants'
            referencedColumns: ['id']
          },
        ]
      }
      order_items: {
        Row: {
          id: string
          order_id: string
          menu_item_id: string | null
          name_snapshot: string
          qty: number
          unit_price_aed: number
          modifiers_snapshot: Json
          notes: string | null
        }
        Insert: {
          id?: string
          order_id: string
          menu_item_id?: string | null
          name_snapshot: string
          qty: number
          unit_price_aed: number
          modifiers_snapshot?: Json
          notes?: string | null
        }
        Update: {
          id?: string
          order_id?: string
          menu_item_id?: string | null
          name_snapshot?: string
          qty?: number
          unit_price_aed?: number
          modifiers_snapshot?: Json
          notes?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'order_items_order_id_fkey'
            columns: ['order_id']
            isOneToOne: false
            referencedRelation: 'orders'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'order_items_menu_item_id_fkey'
            columns: ['menu_item_id']
            isOneToOne: false
            referencedRelation: 'menu_items'
            referencedColumns: ['id']
          },
        ]
      }
      conversations: {
        Row: {
          id: string
          tenant_id: string
          channel: 'whatsapp' | 'dashboard_chat'
          external_id: string | null
          customer_name: string | null
          ai_active: boolean
          created_at: string
        }
        Insert: {
          id?: string
          tenant_id: string
          channel: 'whatsapp' | 'dashboard_chat'
          external_id?: string | null
          customer_name?: string | null
          ai_active?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          tenant_id?: string
          channel?: 'whatsapp' | 'dashboard_chat'
          external_id?: string | null
          customer_name?: string | null
          ai_active?: boolean
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'conversations_tenant_id_fkey'
            columns: ['tenant_id']
            isOneToOne: false
            referencedRelation: 'tenants'
            referencedColumns: ['id']
          },
        ]
      }
      messages: {
        Row: {
          id: string
          conversation_id: string
          direction: 'inbound' | 'outbound'
          author: 'customer' | 'ai' | 'owner' | 'system'
          body: string
          metadata: Json
          created_at: string
        }
        Insert: {
          id?: string
          conversation_id: string
          direction: 'inbound' | 'outbound'
          author: 'customer' | 'ai' | 'owner' | 'system'
          body: string
          metadata?: Json
          created_at?: string
        }
        Update: {
          id?: string
          conversation_id?: string
          direction?: 'inbound' | 'outbound'
          author?: 'customer' | 'ai' | 'owner' | 'system'
          body?: string
          metadata?: Json
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'messages_conversation_id_fkey'
            columns: ['conversation_id']
            isOneToOne: false
            referencedRelation: 'conversations'
            referencedColumns: ['id']
          },
        ]
      }
      printers: {
        Row: {
          id: string
          tenant_id: string
          printnode_id: number
          label: string
          active: boolean
        }
        Insert: {
          id?: string
          tenant_id: string
          printnode_id: number
          label: string
          active?: boolean
        }
        Update: {
          id?: string
          tenant_id?: string
          printnode_id?: number
          label?: string
          active?: boolean
        }
        Relationships: [
          {
            foreignKeyName: 'printers_tenant_id_fkey'
            columns: ['tenant_id']
            isOneToOne: false
            referencedRelation: 'tenants'
            referencedColumns: ['id']
          },
        ]
      }
      ai_usage: {
        Row: {
          id: number
          tenant_id: string
          kind: string
          model: string
          input_tokens: number
          output_tokens: number
          cost_usd: number
          created_at: string
        }
        Insert: {
          id?: number
          tenant_id: string
          kind: string
          model: string
          input_tokens?: number
          output_tokens?: number
          cost_usd?: number
          created_at?: string
        }
        Update: {
          id?: number
          tenant_id?: string
          kind?: string
          model?: string
          input_tokens?: number
          output_tokens?: number
          cost_usd?: number
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'ai_usage_tenant_id_fkey'
            columns: ['tenant_id']
            isOneToOne: false
            referencedRelation: 'tenants'
            referencedColumns: ['id']
          },
        ]
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: {
      order_channel: 'voice' | 'whatsapp' | 'manual'
      order_status: 'new' | 'accepted' | 'preparing' | 'ready' | 'served' | 'cancelled'
    }
    CompositeTypes: Record<string, never>
  }
}
