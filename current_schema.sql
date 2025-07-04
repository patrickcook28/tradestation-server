--
-- PostgreSQL database dump
--

-- Dumped from database version 15.12 (Debian 15.12-1.pgdg120+1)
-- Dumped by pg_dump version 17.5

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: alert_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_log (
    id integer NOT NULL,
    alert_id integer NOT NULL,
    ticker character varying(20) NOT NULL,
    alert_type character varying(50) NOT NULL,
    trigger_price double precision NOT NULL,
    std_dev_level double precision NOT NULL,
    direction character varying(10) NOT NULL,
    message text NOT NULL,
    email_sent boolean NOT NULL,
    created_at timestamp without time zone NOT NULL
);


--
-- Name: alert_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.alert_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: alert_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.alert_log_id_seq OWNED BY public.alert_log.id;


--
-- Name: alert_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_logs (
    id integer NOT NULL,
    alert_id integer,
    ticker character varying(10) NOT NULL,
    trigger_price numeric(10,2) NOT NULL,
    alert_type character varying(20) NOT NULL,
    triggered_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    email_sent boolean DEFAULT false,
    email_sent_at timestamp without time zone,
    sms_sent boolean DEFAULT false,
    sms_sent_at timestamp without time zone
);


--
-- Name: alert_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.alert_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: alert_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.alert_logs_id_seq OWNED BY public.alert_logs.id;


--
-- Name: api_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_credentials (
    id integer NOT NULL,
    access_token character varying(1500) NOT NULL,
    refresh_token character varying(100) NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamp without time zone NOT NULL,
    user_id integer
);


--
-- Name: api_credentials_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.api_credentials_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: api_credentials_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.api_credentials_id_seq OWNED BY public.api_credentials.id;


--
-- Name: o_auth_credential; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.o_auth_credential (
    id integer NOT NULL,
    access_token character varying(1500) NOT NULL,
    refresh_token character varying(256) NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL
);


--
-- Name: o_auth_credential_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.o_auth_credential_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: o_auth_credential_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.o_auth_credential_id_seq OWNED BY public.o_auth_credential.id;


--
-- Name: order; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."order" (
    id integer NOT NULL,
    order_data json NOT NULL,
    order_id character varying(256) NOT NULL,
    parent_order_id integer
);


--
-- Name: order_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.order_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: order_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.order_id_seq OWNED BY public."order".id;


--
-- Name: pgmigrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pgmigrations (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    run_on timestamp without time zone NOT NULL
);


--
-- Name: pgmigrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pgmigrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pgmigrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pgmigrations_id_seq OWNED BY public.pgmigrations.id;


--
-- Name: std_dev_levels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.std_dev_levels (
    id integer NOT NULL,
    ticker character varying(10) NOT NULL,
    timeframe character varying(20) DEFAULT '1hour'::character varying NOT NULL,
    mean_price numeric(10,2),
    std_dev numeric(10,2),
    std_dev_1_upper numeric(10,2),
    std_dev_1_lower numeric(10,2),
    std_dev_1_5_upper numeric(10,2),
    std_dev_1_5_lower numeric(10,2),
    std_dev_2_upper numeric(10,2),
    std_dev_2_lower numeric(10,2),
    bars_count integer,
    last_calculated timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    reference_price numeric(10,2)
);


--
-- Name: std_dev_levels_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.std_dev_levels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: std_dev_levels_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.std_dev_levels_id_seq OWNED BY public.std_dev_levels.id;


--
-- Name: trade_alert; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trade_alert (
    id integer NOT NULL,
    ticker character varying(20) NOT NULL,
    alert_type character varying(50) NOT NULL,
    timeframe character varying(20) NOT NULL,
    direction character varying(10) NOT NULL,
    is_active boolean NOT NULL,
    last_triggered timestamp without time zone,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL
);


--
-- Name: trade_alert_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trade_alert_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trade_alert_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trade_alert_id_seq OWNED BY public.trade_alert.id;


--
-- Name: trade_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trade_alerts (
    id integer NOT NULL,
    user_id integer,
    ticker character varying(10) NOT NULL,
    alert_type character varying(20) NOT NULL,
    price_level numeric(10,2) NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    timeframe character varying(20),
    std_dev_level character varying(30),
    description text,
    indicator_type character varying(20),
    indicator_period integer,
    CONSTRAINT trade_alerts_alert_type_check CHECK (((alert_type)::text = ANY ((ARRAY['above'::character varying, 'below'::character varying])::text[])))
);


--
-- Name: trade_alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trade_alerts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trade_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trade_alerts_id_seq OWNED BY public.trade_alerts.id;


--
-- Name: trade_journal; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trade_journal (
    id integer NOT NULL,
    trade_setup character varying(100),
    trade_mistakes character varying(100),
    trade_results character varying(100),
    trade_rating character varying(10),
    trade_r double precision,
    notes text,
    image_path character varying(100)
);


--
-- Name: trade_journal_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trade_journal_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trade_journal_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trade_journal_id_seq OWNED BY public.trade_journal.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    email character varying(100) NOT NULL,
    password character varying(100) NOT NULL
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: alert_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_log ALTER COLUMN id SET DEFAULT nextval('public.alert_log_id_seq'::regclass);


--
-- Name: alert_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_logs ALTER COLUMN id SET DEFAULT nextval('public.alert_logs_id_seq'::regclass);


--
-- Name: api_credentials id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_credentials ALTER COLUMN id SET DEFAULT nextval('public.api_credentials_id_seq'::regclass);


--
-- Name: o_auth_credential id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.o_auth_credential ALTER COLUMN id SET DEFAULT nextval('public.o_auth_credential_id_seq'::regclass);


--
-- Name: order id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."order" ALTER COLUMN id SET DEFAULT nextval('public.order_id_seq'::regclass);


--
-- Name: pgmigrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pgmigrations ALTER COLUMN id SET DEFAULT nextval('public.pgmigrations_id_seq'::regclass);


--
-- Name: std_dev_levels id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.std_dev_levels ALTER COLUMN id SET DEFAULT nextval('public.std_dev_levels_id_seq'::regclass);


--
-- Name: trade_alert id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_alert ALTER COLUMN id SET DEFAULT nextval('public.trade_alert_id_seq'::regclass);


--
-- Name: trade_alerts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_alerts ALTER COLUMN id SET DEFAULT nextval('public.trade_alerts_id_seq'::regclass);


--
-- Name: trade_journal id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_journal ALTER COLUMN id SET DEFAULT nextval('public.trade_journal_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: alert_log alert_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_log
    ADD CONSTRAINT alert_log_pkey PRIMARY KEY (id);


--
-- Name: alert_logs alert_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_logs
    ADD CONSTRAINT alert_logs_pkey PRIMARY KEY (id);


--
-- Name: api_credentials api_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_credentials
    ADD CONSTRAINT api_credentials_pkey PRIMARY KEY (id);


--
-- Name: o_auth_credential o_auth_credential_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.o_auth_credential
    ADD CONSTRAINT o_auth_credential_pkey PRIMARY KEY (id);


--
-- Name: order order_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."order"
    ADD CONSTRAINT order_pkey PRIMARY KEY (id);


--
-- Name: pgmigrations pgmigrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pgmigrations
    ADD CONSTRAINT pgmigrations_pkey PRIMARY KEY (id);


--
-- Name: std_dev_levels std_dev_levels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.std_dev_levels
    ADD CONSTRAINT std_dev_levels_pkey PRIMARY KEY (id);


--
-- Name: std_dev_levels std_dev_levels_ticker_timeframe_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.std_dev_levels
    ADD CONSTRAINT std_dev_levels_ticker_timeframe_key UNIQUE (ticker, timeframe);


--
-- Name: trade_alert trade_alert_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_alert
    ADD CONSTRAINT trade_alert_pkey PRIMARY KEY (id);


--
-- Name: trade_alerts trade_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_alerts
    ADD CONSTRAINT trade_alerts_pkey PRIMARY KEY (id);


--
-- Name: trade_journal trade_journal_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_journal
    ADD CONSTRAINT trade_journal_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_alert_logs_alert_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_logs_alert_id ON public.alert_logs USING btree (alert_id);


--
-- Name: idx_alert_logs_ticker; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_logs_ticker ON public.alert_logs USING btree (ticker);


--
-- Name: idx_trade_alerts_ticker; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trade_alerts_ticker ON public.trade_alerts USING btree (ticker);


--
-- Name: idx_trade_alerts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trade_alerts_user_id ON public.trade_alerts USING btree (user_id);


--
-- Name: alert_log alert_log_alert_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_log
    ADD CONSTRAINT alert_log_alert_id_fkey FOREIGN KEY (alert_id) REFERENCES public.trade_alert(id);


--
-- Name: alert_logs alert_logs_alert_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_logs
    ADD CONSTRAINT alert_logs_alert_id_fkey FOREIGN KEY (alert_id) REFERENCES public.trade_alerts(id) ON DELETE CASCADE;


--
-- Name: api_credentials api_credentials_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_credentials
    ADD CONSTRAINT api_credentials_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: order order_parent_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."order"
    ADD CONSTRAINT order_parent_order_id_fkey FOREIGN KEY (parent_order_id) REFERENCES public."order"(id);


--
-- Name: trade_alerts trade_alerts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_alerts
    ADD CONSTRAINT trade_alerts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

